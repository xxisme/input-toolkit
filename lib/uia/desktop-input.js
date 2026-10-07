/**
 * lib/desktop-input.js
 *
 * prompt-polisher 的 OS 级 UI 自动化层 —— 唯一一处与 Windows UI 耦合的代码。
 *
 * 架构(第二轮重构后):
 *   1) 执行层 runPs():**一份静态 PowerShell 脚本** + **JSON over stdin** 传参。
 *      - 脚本通过 -EncodedCommand(base64 UTF-16LE)传入 → 中文/Unicode 安全;
 *      - 动态数据(要写的文本、期望原文、rescue 开关)走 stdin 的 UTF-8 JSON,
 *        由 PS 侧 ConvertFrom-Json 解析。这样:
 *          · 没有 PowerShell 字符串拼接 → 无注入面(旧的 $action 拼接已移除);
 *          · 没有命令行长度限制 → 超长提示词不会再把 -EncodedCommand 撑爆;
 *          · 不需要 psQuote。
 *      - 硬超时 + taskkill /F /T 杀进程树(用 import 进来的 execFileSync,
 *        旧代码在 ESM 里写 require() 是死代码)。
 *   2) 脚本层:一个脚本两种 mode(read / write)。
 *      - read :UIA TextPattern 读 inputBox(不模拟键盘、不动剪贴板、不抢焦点)
 *      - write:UIA 定位 + SetFocus + 鼠标点击 + 剪贴板粘贴
 *
 * 定位 inputBox:
 *   HanaAgent 进程有多个顶层窗口(主窗 + 匿名小 Pane,会随状态出现/消失),
 *   所以遍历所有顶层窗口找含 AutomationId="inputBox" 的那个,而不是 FindFirst 取第一个。
 *   容器是 TipTap ProseMirror(ClassName=tiptap ProseMirror _input-box_*),
 *   ControlType=Group,提供只读 TextPattern(ValuePattern 不可用),所以写入只能走键盘+剪贴板。
 *
 * 安全门:
 *   - 模拟 Ctrl+A/C/V 会作用于"当前前台窗口的焦点控件"。写路径在发按键前**二次**校验前台
 *     仍是 HanaAgent(缩小 setClipboard → 发按键之间的 TOCTOU 窗口),不是就恢复剪贴板并
 *     取消,绝不把内容打进别的窗口。
 *   - rescue=false(focusShortcut=never)时不做前台救援,写路径直接失败而非抢焦点。
 *
 * 已知保真限制:
 *   TipTap 把 `` `code` `` / **bold** / *italic* 渲染成富文本 mark,TextPattern 只能读到
 *   渲染后的纯文本(标记丢失);标题 / 列表 / 围栏代码块 / 链接 / 引用这类块级语法可保留。
 *
 * 错误码:
 *   { ok:true, value } / { ok:true, length, readback }
 *   { ok:false, code, message }
 *   code ∈ NO_HANA | NO_INPUT_BOX | NO_HANA_FOREGROUND | COMPOSER_CHANGED |
 *          CLIPBOARD_ERROR | WRITE_MISMATCH | WIN32_ERROR | WIN32_TIMEOUT
 */
import { spawn, execFileSync } from "node:child_process";

const PS_EXE = process.env.SystemRoot
  ? `${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
  : "powershell.exe";

/** 各路径的硬超时(ms)。超时即 taskkill /F /T,保证调用方永远不会挂死。 */
const TIMEOUT = {
  read: 12000,   // 优化路径读(含可能的 300ms×3 元素重试)
  watch: 8000,   // 后台轮询读(要快,失败就跳过这一轮)
  write: 20000,  // 写回(剪贴板 + 多次按键 + 回读)
};

/**
 * 从 PowerShell 的 CLIXML stderr 里提取人话错误。
 * PS 5.1 的错误输出是 <S S="Error">真实错误文本</S>(E 大写),老版本才是 <Obj S="error"><AV>。
 */
function extractCliXmlError(raw) {
  const text = String(raw || "");
  if (!text.includes("CLIXML")) return text.slice(0, 300);
  const sErr = [...text.matchAll(/<S S="Error">([\s\S]*?)<\/S>/g)].map((m) => m[1]);
  if (sErr.length) {
    const decoded = sErr
      .map((s) => s
        .replace(/_x000D_/g, "\r")
        .replace(/_x000A_/g, "\n")
        .replace(/_x003C_/g, "<")
        .replace(/_x003E_/g, ">")
        .replace(/_x0027_/g, "'")
        .trim())
      .filter(Boolean);
    if (decoded.length) return [...new Set(decoded)].join("\n").slice(0, 500);
  }
  const errBlocks = [...text.matchAll(/<Obj S="error"[\s\S]*?<AV>([^<]+)<\/AV>/g)].map((m) => m[1]);
  if (errBlocks.length) return [...new Set(errBlocks)].join(" | ").slice(0, 500);
  const av = [...text.matchAll(/<(?:AV|VE)>([^<]+)<\/(?:AV|VE)>/g)].map((m) => m[1]);
  if (av.length) return [...new Set(av)].join(" | ").slice(0, 500);
  return text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 500);
}

// ── 执行层 ──────────────────────────────────────────────────────────────

/**
 * 执行一份 PS 脚本。脚本走 -EncodedCommand,动态数据走 stdin 的 UTF-8 JSON。
 * 永不 reject:任何异常/超时都 resolve 成 { ok:false, code, message }。
 *
 * @param {string} script       完整 PS 脚本
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs]
 * @param {object|null} [opts.request]  要 JSON 序列化后写到 stdin 的请求体
 * @param {string} [opts.tag]           日志/错误里的动作名
 */
function runPs(script, opts = {}) {
  const { timeoutMs = TIMEOUT.read, request = null, tag = "ps" } = opts;
  const encoded = Buffer.from(script, "utf16le").toString("base64");

  return new Promise((resolve) => {
    let settled = false;
    let proc = null;

    const finish = (val) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      resolve(val);
    };

    // 硬超时:Windows 上 Node 自带的 spawn timeout 对 PS 进程不一定 kill 干净
    // (PS 可能拉辅助进程),所以自己 taskkill /F /T 杀进程树。
    const hardTimer = setTimeout(() => {
      if (settled) return;
      try { proc?.kill?.(); } catch {}
      try {
        execFileSync("taskkill", ["/F", "/T", "/PID", String(proc?.pid ?? 0)], { stdio: "ignore", windowsHide: true });
      } catch {}
      finish({ ok: false, code: "WIN32_TIMEOUT", message: `powershell ${tag} 超过 ${timeoutMs}ms 未结束,已强制结束进程` });
    }, timeoutMs);
    hardTimer.unref?.();

    try {
      proc = spawn(
        PS_EXE,
        ["-NoProfile", "-NonInteractive", "-Sta", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
        { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
      );
    } catch (e) {
      return finish({ ok: false, code: "WIN32_ERROR", message: `spawn failed: ${e?.message || e}` });
    }

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => { stdout += d.toString("utf8"); });
    proc.stderr.on("data", (d) => { stderr += d.toString("utf8"); });
    proc.on("error", (e) => finish({ ok: false, code: "WIN32_ERROR", message: `spawn error: ${e?.message || e}` }));

    // 把请求体写到 stdin 并立刻关闭:PS 侧用 OpenStandardInput().CopyTo 读到 EOF。
    // 即使是 read 路径也必须 end(),否则 PS 侧读取会一直阻塞直到硬超时。
    try {
      proc.stdin.on("error", () => {}); // EPIPE 之类的写错误不能冒泡成 unhandled
      if (request != null) proc.stdin.write(Buffer.from(JSON.stringify(request), "utf8"));
      proc.stdin.end();
    } catch { /* 忽略:PS 侧会拿到空 stdin */ }

    proc.on("close", () => {
      if (settled) return;
      // 无论退出码如何,先尝试从 stdout 里解析最后一行 JSON(终止性错误时 stdout 也可能有结果)
      const lines = stdout.split(/\r?\n/).filter((l) => l.trim().startsWith("{"));
      const lastJson = lines[lines.length - 1] || "";
      if (lastJson) {
        try {
          const obj = JSON.parse(lastJson);
          if (obj && typeof obj === "object") {
            // value/readback/current 是 base64(避免 JSON 转义任意文本)
            if (typeof obj.value === "string") obj.value = b64ToUtf8(obj.value);
            if (typeof obj.readback === "string") obj.readback = b64ToUtf8(obj.readback);
            if (typeof obj.current === "string") obj.current = b64ToUtf8(obj.current);
            // 附上原始 stdout：剪贴板快照脚本靠它拿 base64 负载 ——
            // 那个负载可能很大，不适合走 Emit 的 JSON 通道。
            return finish({ ...obj, raw: stdout });
          }
        } catch {}
      }
      const cliXmlMsg = extractCliXmlError(stderr);
      const stderrShort = String(stderr || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
      const stdoutShort = String(stdout || "").trim().slice(-200);
      const parts = [];
      if (cliXmlMsg && cliXmlMsg !== stderrShort) parts.push(`cli=${cliXmlMsg}`);
      if (stderrShort) parts.push(`stderr=${stderrShort}`);
      if (stdoutShort) parts.push(`stdout-tail=${stdoutShort}`);
      finish({
        ok: false,
        code: "WIN32_ERROR",
        message: parts.join(" | ") || "powershell exec failed(无输出)",
      });
    });
  });
}

function b64ToUtf8(s) {
  try { return Buffer.from(String(s), "base64").toString("utf8"); } catch { return ""; }
}

// ── 脚本层 ──────────────────────────────────────────────────────────────

// 内联 C# 只声明真正用到的 Win32 API。
// 注意:dll 必须写对 —— GetCurrentThreadId 在 kernel32(不是 user32);
// 不写 using System.Windows.Forms(Add-Type 内联编译不加载该程序集,会 CS0234 直接失败)。
const W32_TYPE = [
  "Add-Type @'",
  "using System;",
  "using System.Runtime.InteropServices;",
  "public class PPW32 {",
  "  [DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow();",
  "  [DllImport(\"user32.dll\")] public static extern int GetWindowThreadProcessId(IntPtr hWnd, out int processId);",
  "  [DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(IntPtr hWnd);",
  "  [DllImport(\"user32.dll\")] public static extern bool SetCursorPos(int X, int Y);",
  "  [DllImport(\"user32.dll\")] public static extern void mouse_event(uint dwFlags, int dx, int dy, uint dwData, int dwExtraInfo);",
  "  [DllImport(\"user32.dll\")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, int dwExtraInfo);",
  "  [DllImport(\"user32.dll\")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);",
  "  [DllImport(\"user32.dll\")] public static extern bool IsIconic(IntPtr hWnd);",
  "  [DllImport(\"user32.dll\")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);",
  "  [DllImport(\"kernel32.dll\")] public static extern uint GetCurrentThreadId();",
  "  public const int SW_RESTORE = 9;",
  "  public const byte VK_CONTROL = 0x11;",
  "  public const byte VK_A = 0x41;",
  "  public const byte VK_V = 0x56;",
  "  public const byte VK_DELETE = 0x2E;",
  "  public const byte VK_RIGHT = 0x27;",
  "  public const byte VK_MENU = 0x12;",
  "  public const uint KEYEVENTF_KEYUP = 0x0002;",
  "  public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;",
  "  public const uint MOUSEEVENTF_LEFTUP = 0x0004;",
  "}",
  "'@",
];

const PS_HELPERS = [
  // 统一输出:JSON 一行;文本字段一律 base64,避免任意字符(换行/控制符)破坏 JSON
  "function Emit($h) { [Console]::Out.WriteLine(($h | ConvertTo-Json -Compress -Depth 4)) }",
  "function B64([string]$s) { if ($null -eq $s) { return '' }; return [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($s)) }",
  // 读 stdin 的 UTF-8 JSON 请求体
  "function Read-Req {",
  "  try {",
  "    $sin = [Console]::OpenStandardInput()",
  "    $ms = New-Object System.IO.MemoryStream",
  "    $sin.CopyTo($ms)",
  "    $raw = [System.Text.Encoding]::UTF8.GetString($ms.ToArray())",
  "    if ([string]::IsNullOrWhiteSpace($raw)) { return New-Object psobject }",
  "    return ($raw | ConvertFrom-Json)",
  "  } catch { return New-Object psobject }",
  "}",
  // 找 HanaAgent 主窗口进程(严格排除 hana-server 等无窗口进程)
  "function Find-HanaProc {",
  "  return Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match '(?i)^hanaagent$' -and $_.MainWindowHandle -ne 0 } | Select-Object -First 1",
  "}",
  "function Get-FgPid { $p = 0; [PPW32]::GetWindowThreadProcessId([PPW32]::GetForegroundWindow(), [ref]$p) | Out-Null; return $p }",
  // 前台救援:只在目标窗口**被最小化**时才抢。
  //
  // 为什么不能无条件抢：用户点工具 → 读输入框（此刻 HanaAgent 在前台）→
  // 调模型 2~8 秒 → 写回。这中间他完全可能 Alt+Tab 去 Word 写东西。
  // 无条件抢的代价：把 HanaAgent 拉到最前，他接下来一秒敲的字落进提示词输入框，
  // 然后被 Ctrl+A + 粘贴覆盖。乐观锁救不了 —— 锁是在抢回焦点**之后**才检查的，
  // 那一刻输入框里还是原文，检查通过，照样覆盖。
  //
  // 还有一个更隐蔽的坑：`keybd_event` 是**全局注入**，发给的是当前前台窗口。
  // 所以就算后面不调 SetForegroundWindow，那一下 Alt 也已经砸在用户正在用的程序上了。
  // 守卫必须放在任何 keybd_event **之前**。
  //
  // 规则：窗口好好开着而前台是别的程序 ⇒ 用户是主动切走的 ⇒ 不抢，如实报错。
  // 只有它被最小化了才拉回来（那多半是无意的，而且能撤销）。
  "function Rescue-Foreground([IntPtr]$hwnd) {",
  "  if (-not [PPW32]::IsIconic($hwnd)) { return $false }",
  "  [void][PPW32]::ShowWindowAsync($hwnd, [PPW32]::SW_RESTORE)",
  "  Start-Sleep -Milliseconds 300",
  "  $dummy = 0",
  "  $fgThread = [PPW32]::GetWindowThreadProcessId([PPW32]::GetForegroundWindow(), [ref]$dummy)",
  "  $myThread = [PPW32]::GetCurrentThreadId()",
  "  $attached = $false",
  "  try { $attached = [PPW32]::AttachThreadInput($myThread, $fgThread, $true) } catch {}",
  "  try {",
  "    [PPW32]::keybd_event([PPW32]::VK_MENU, 0, 0, 0)",
  "    [PPW32]::keybd_event([PPW32]::VK_MENU, 0, [PPW32]::KEYEVENTF_KEYUP, 0)",
  "    Start-Sleep -Milliseconds 60",
  "    [void][PPW32]::SetForegroundWindow($hwnd)",
  "    Start-Sleep -Milliseconds 200",
  "  } finally { if ($attached) { [void][PPW32]::AttachThreadInput($myThread, $fgThread, $false) } }",
  "  return $true",
  "}",
  // 遍历所有顶层窗口找 inputBox(进程可能同时有主窗 + 匿名小 Pane)
  // 参数不能叫 $pid —— 那是 PowerShell 只读自动变量,赋值会直接报错
  "function Find-InputBox([int]$targetPid) {",
  "  $pidCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $targetPid)",
  "  $wins = [System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $pidCond)",
  "  if (-not $wins -or $wins.Count -eq 0) { return $null }",
  "  $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty, 'inputBox')",
  "  for ($t = 0; $t -lt 3; $t++) {",
  "    foreach ($w in $wins) { $el = $w.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond); if ($el) { return $el } }",
  "    Start-Sleep -Milliseconds 300",
  "  }",
  "  return $null",
  "}",
  // 只读 TextPattern 读全文(-1 = 不限长度,避免超长提示词被静默截断)
  "function Read-Composer($el) {",
  "  try {",
  "    $tp = $el.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern)",
  "    if ($tp) { return $tp.DocumentRange.GetText(-1) }",
  "  } catch {}",
  "  return ''",
  "}",
  // 占位符过滤:只在文本很短时才当占位符,避免误伤真以这些字开头的长输入
  "function Strip-Placeholder([string]$t) {",
  "  if ([string]::IsNullOrEmpty($t)) { return '' }",
  "  $x = $t.Trim()",
  "  if ($x.Length -le 20 -and ($x -like '说点什么*' -or $x -like 'Start typing*' -or $x -like '请输入*')) { return '' }",
  "  return $t",
  "}",
];

/**
 * 构造主脚本。mode 由 stdin 请求体决定(read / write)。
 * 脚本本身完全静态,不含任何插值 —— 防注入 + 不受命令行长度限制。
 */
function buildAgentScript() {
  return [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName UIAutomationClient",
    "Add-Type -AssemblyName UIAutomationTypes",
    "try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}",
    ...W32_TYPE,
    ...PS_HELPERS,
    "$req = Read-Req",
    "$mode = [string]$req.mode",
    "$rescue = $true",
    "if ($null -ne $req.rescue) { $rescue = [bool]$req.rescue }",
    "",
    "$proc = Find-HanaProc",
    "if (-not $proc) { Emit @{ ok = $false; code = 'NO_HANA'; message = '未找到 HanaAgent 主窗口进程(HanaAgent 没运行?)' }; exit 0 }",
    "$hwnd = $proc.MainWindowHandle",
    "$fg = Get-FgPid",
    "if ($fg -ne $proc.Id) {",
    "  $wasMinimized = [PPW32]::IsIconic($hwnd)",
    "  if ($rescue) { [void](Rescue-Foreground $hwnd); $fg = Get-FgPid }",
    "  if ($fg -ne $proc.Id) {",
    "    if ($mode -eq 'write') {",
    "      $fgName = (Get-Process -Id $fg -ErrorAction SilentlyContinue).ProcessName",
    // 分两种说法，因为用户该做的动作不一样。
    "      if (-not $wasMinimized) { Emit @{ ok = $false; code = 'NO_HANA_FOREGROUND'; message = ('生成期间你切到了其它程序(当前:{0});为免抢走你的输入已取消,请回到 HanaAgent 再点一次' -f $fgName) } } else { Emit @{ ok = $false; code = 'NO_HANA_FOREGROUND'; message = ('前台窗口不是 HanaAgent(当前: {0});为避免误写入其它窗口已取消,请点一下 HanaAgent 窗口再试' -f $fgName) } }",
    "      exit 0",
    "    }",
    "    # read 不拦:UIA TextPattern 可在后台读;若窗口最小化导致树稀疏,下面会报 NO_INPUT_BOX",
    "  }",
    "}",
    "",
    "$el = Find-InputBox $proc.Id",
    "if (-not $el) { Emit @{ ok = $false; code = 'NO_INPUT_BOX'; message = 'UIA 找不到输入框(AutomationId=inputBox 不存在,HanaAgent 界面结构可能变了)' }; exit 0 }",
    "",
    "if ($mode -eq 'read') {",
    "  $text = Strip-Placeholder (Read-Composer $el)",
    "  Emit @{ ok = $true; value = (B64 $text) }",
    "  exit 0",
    "}",
    "",
    "# ── write ──",
    "Add-Type -AssemblyName System.Windows.Forms",
    "$newText = [string]$req.text",
    "",
    "# 乐观锁:写回前若输入框已不是读到的原文(用户改了 / 切了会话),放弃写回",
    "if ($null -ne $req.expect) {",
    "  $cur = Strip-Placeholder (Read-Composer $el)",
    "  if ($cur -ne [string]$req.expect) {",
    "    Emit @{ ok = $false; code = 'COMPOSER_CHANGED'; message = '输入框内容在优化期间已变化,已取消写回以免覆盖'; current = (B64 $cur) }",
    "    exit 0",
    "  }",
    "}",
    "",
    "# ── 剪贴板快照：必须早于任何鼠标操作 ──",
    "# 早先的顺序是「点击 → 快照 → 写剪贴板 → 恢复」。点击本身就可能改写剪贴板",
    "# （点到复制按钮、选中一段文字），那时候快照到的已经是被污染的内容。",
    "# 快照:把每个格式的数据**立即取出来**(GetData),不能只存 IDataObject 引用 ——",
    "# 一旦我们覆盖剪贴板,原 owner 的延迟渲染就失效,恢复必然失败并丢掉用户内容(图片/文件列表)。",
    "$clipText = $null",
    "$clipIsText = $false",
    "$clipData = @{}",
    "try {",
    "  if ([System.Windows.Forms.Clipboard]::ContainsText()) { $clipText = [System.Windows.Forms.Clipboard]::GetText(); $clipIsText = $true }",
    "  $srcObj = [System.Windows.Forms.Clipboard]::GetDataObject()",
    "  if ($srcObj) {",
    "    foreach ($fmt in $srcObj.GetFormats($true)) {",
    "      try { $clipData[$fmt] = $srcObj.GetData($fmt) } catch {}",
    "    }",
    "  }",
    "} catch {}",
    "function Restore-Clip {",
    "  try {",
    "    if ($clipData.Count -gt 0) {",
    "      $nd = New-Object System.Windows.Forms.DataObject",
    "      foreach ($k in $clipData.Keys) { try { $nd.SetData($k, $clipData[$k]) } catch {} }",
    "      [System.Windows.Forms.Clipboard]::SetDataObject($nd, $true)",
    "    } elseif ($clipIsText) {",
    "      [System.Windows.Forms.Clipboard]::SetText($clipText)",
    "    } else {",
    "      [System.Windows.Forms.Clipboard]::Clear()",
    "    }",
    "  } catch {",
    "    try { if ($clipIsText) { [System.Windows.Forms.Clipboard]::SetText($clipText) } else { [System.Windows.Forms.Clipboard]::Clear() } } catch {}",
    "  }",
    "}",
    "function Sim-Key([byte]$vk) {",
    "  [PPW32]::keybd_event($vk, 0, 0, 0)",
    "  Start-Sleep -Milliseconds 25",
    "  [PPW32]::keybd_event($vk, 0, [PPW32]::KEYEVENTF_KEYUP, 0)",
    "  Start-Sleep -Milliseconds 60",
    "}",
    "function Sim-Ctrl([byte]$vk) {",
    "  [PPW32]::keybd_event([PPW32]::VK_CONTROL, 0, 0, 0)",
    "  Start-Sleep -Milliseconds 30",
    "  [PPW32]::keybd_event($vk, 0, 0, 0)",
    "  Start-Sleep -Milliseconds 30",
    "  [PPW32]::keybd_event($vk, 0, [PPW32]::KEYEVENTF_KEYUP, 0)",
    "  Start-Sleep -Milliseconds 30",
    "  [PPW32]::keybd_event([PPW32]::VK_CONTROL, 0, [PPW32]::KEYEVENTF_KEYUP, 0)",
    "  Start-Sleep -Milliseconds 90",
    "}",
    "function Fg-Is-Hana { return ((Get-FgPid) -eq $proc.Id) }",
    "",
    "try {",
    "  # ── 鼠标点击：三重保护，缺一不可 ──",
    "  # 早先这里是 SetFocus → 取屏幕坐标 → SetCursorPos → 点击，**没有任何前台校验**。",
    "  # 而 Fg-Is-Hana 的检查都在点击**之后**。那是致命缺口：",
    "  # 坐标是屏幕绝对坐标，用户在 SetCursorPos 与 mouse_event 之间(约 390ms)",
    "  # 切走/移动/最小化窗口，这一击就落在那个坐标上的任意窗口里 ——",
    "  # 删一条消息、点一个确认、关掉一个文档，都在这一下之内。",
    "  #",
    "  # **位置很重要**：这段必须在 Restore-Clip / Fg-Is-Hana 等函数定义之后、",
    "  # 且在 try 之内。早先它被插在函数定义之前，调用 Fg-Is-Hana 时它还不存在，",
    "  # 真机直接报「写回失败:cli=Fg-Is-Hana : ...」——整个优化功能不可用。",
    "  # PowerShell 不会因为“函数晚一点定义”而提前解析，调用时才报错。",
    "  if (-not (Fg-Is-Hana)) { Restore-Clip; Emit @{ ok = $false; code = 'NO_HANA_FOREGROUND'; message = '点击前发现前台已切走,已取消(未点击任何位置)' }; exit 0 }",
    "  try { [void]$el.SetFocus() } catch {}",
    "  Start-Sleep -Milliseconds 120",
    "  if (-not (Fg-Is-Hana)) { Restore-Clip; Emit @{ ok = $false; code = 'NO_HANA_FOREGROUND'; message = '聚焦后前台已切走,已取消(未点击任何位置)' }; exit 0 }",
    "  $r = $el.Current.BoundingRectangle",
    "  if ($r.IsEmpty -or $r.Width -le 0 -or $r.Height -le 0) { Restore-Clip; Emit @{ ok = $false; code = 'NO_INPUT_BOX'; message = '输入框位置已失效,已取消点击' }; exit 0 }",
    "  $cx = [int]($r.X + $r.Width / 2)",
    "  $cy = [int]($r.Y + $r.Height / 2)",
    "  # 目标点必须落在虚拟屏幕内。最小化的窗口其 BoundingRectangle 往往为空或负值，",
    "  # 负坐标会让 SetCursorPos 钳位，点击就落到屏幕左上角 —— 那儿通常是任务栏或开始按钮。",
    "  $scr = [System.Windows.Forms.SystemInformation]::VirtualScreen",
    "  if ($cx -lt $scr.Left -or $cx -gt $scr.Right -or $cy -lt $scr.Top -or $cy -gt $scr.Bottom) {",
    "    Restore-Clip; Emit @{ ok = $false; code = 'NO_INPUT_BOX'; message = '输入框不在屏幕范围内(可能被最小化),已取消点击' }; exit 0",
    "  }",
    "  # 记下原指针位置：早先移走就再也没还回去，用户从别的窗口 Alt+Tab 回来时",
    "  # 第一下点击会打在 HanaAgent 的输入框里，而那个窗口毫无防备。",
    "  $pt = [System.Windows.Forms.Cursor]::Position",
    "  [PPW32]::SetCursorPos($cx, $cy) | Out-Null",
    "  Start-Sleep -Milliseconds 40",
    "  # 移过去之后再验一次：这几十毫秒里用户完全可能把窗口拖走了。",
    "  if (-not (Fg-Is-Hana)) {",
    "    [PPW32]::SetCursorPos($pt.X, $pt.Y) | Out-Null",
    "    Restore-Clip; Emit @{ ok = $false; code = 'NO_HANA_FOREGROUND'; message = '移动指针后前台已切走,已取消点击并归还指针' }; exit 0",
    "  }",
    "  [PPW32]::mouse_event([PPW32]::MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0)",
    "  Start-Sleep -Milliseconds 30",
    "  [PPW32]::mouse_event([PPW32]::MOUSEEVENTF_LEFTUP, 0, 0, 0, 0)",
    "  [PPW32]::SetCursorPos($pt.X, $pt.Y) | Out-Null",
    "  Start-Sleep -Milliseconds 200",
    "  if ($newText.Length -eq 0) {",
    "    # 空串:Clipboard.SetText('') 会抛;直接用 Ctrl+A + Delete 清空",
    "    if (-not (Fg-Is-Hana)) { Emit @{ ok = $false; code = 'NO_HANA_FOREGROUND'; message = '写回前发现前台已切走,已取消(未发送任何按键)' }; exit 0 }",
    "    Sim-Ctrl([PPW32]::VK_A)",
    "    Sim-Key([PPW32]::VK_DELETE)",
    "  } else {",
    "    try { [System.Windows.Forms.Clipboard]::SetText($newText) } catch { Restore-Clip; Emit @{ ok = $false; code = 'CLIPBOARD_ERROR'; message = $_.Exception.Message }; exit 0 }",
    "    # TOCTOU 二次校验:设完剪贴板、发按键之前再验一次前台,把「打到别的窗口」的窗口尽量压小",
    "    if (-not (Fg-Is-Hana)) { Restore-Clip; Emit @{ ok = $false; code = 'NO_HANA_FOREGROUND'; message = '写回前发现前台已切走,已取消(未发送任何按键)' }; exit 0 }",
    "    Sim-Ctrl([PPW32]::VK_A)",
    "    Sim-Ctrl([PPW32]::VK_V)",
    "  }",
    "  # 粘贴一完成就**立即**恢复剪贴板。",
    "  # 早先恢复排在 Sim-Key(VK_RIGHT) 与 150ms sleep 之后，把危险窗口拉长了一倍。",
    "  # 危险窗口 = 「已覆盖剪贴板」到「已恢复」之间的全部时间；这段时间里进程被强杀，",
    "  # 用户的截图/文件列表就永久没了。窗口越短越好。",
    "  Restore-Clip",
    "  Sim-Key([PPW32]::VK_RIGHT)", // 收起选区,消除全选高亮残留
    "  Start-Sleep -Milliseconds 150",
    "  $rb = Strip-Placeholder (Read-Composer $el)",
    "  Emit @{ ok = $true; length = $newText.Length; readback = (B64 $rb) }",
    "} catch {",
    "  Restore-Clip",
    "  Emit @{ ok = $false; code = 'WIN32_ERROR'; message = $_.Exception.Message }",
    "}",
  ].join("\n");
}

const AGENT_SCRIPT = buildAgentScript();

/**
 * 剪贴板快照脚本：只读，不碰前台。
 *
 * 为什么需要它：主脚本里的 Restore-Clip 只能在**进程活着**时跑。
 * 而 JS 侧的超时处理是 taskkill /F /T —— 进程被强杀，PowerShell 的
 * try/catch/finally 一行都不会执行，用户的截图/文件列表就没了。
 *
 * 缩短脚本内的危险窗口能降低概率，但消不掉：只要存在「已覆盖剪贴板」到
 * 「已恢复」这段时间，就存在被强杀的可能。所以 JS 侧自己拿一份快照兼底。
 *
 * 能力边界（实话实说）：这里只能可靠地快照与恢复**文本**。
 * 图片/文件列表等多格式数据跨进程序列化代价高、失败率高，
 * 重建路径不可靠。与其写一个“看起来能恢复、实际悄悄丢格式”的实现，
 * 不如只保文本、其余情况明确告知用户去按 Ctrl+Z 或重新复制。
 */
const CLIP_SNAPSHOT_SCRIPT = [
  "Add-Type -AssemblyName System.Windows.Forms",
  "try {",
  "  if ([System.Windows.Forms.Clipboard]::ContainsText()) {",
  "    $t = [System.Windows.Forms.Clipboard]::GetText()",
  "    $b = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($t))",
  "    Write-Output ('{\"ok\":true,\"text\":true,\"data\":\"' + $b + '\"}')",
  "  } else {",
  "    $o = [System.Windows.Forms.Clipboard]::GetDataObject()",
  "    $has = $false",
  "    if ($o) { $has = (@($o.GetFormats($false)).Count -gt 0) }",
  "    Write-Output ('{\"ok\":true,\"text\":false,\"rich\":' + $(if ($has) {'true'} else {'false'}) + '}')",
  "  }",
  "} catch {",
  "  Write-Output '{\"ok\":false}'",
  "}",
].join("\n");

/** 兼底快照：写回失败时用它把剪贴板恢复回去。 */
let clipFallback = null;

/**
 * 写回串行闸门。
 *
 * 为什么必须有：`clipFallback` 是**单槽**，而 UIA 只能看到**前台那个**输入框。
 * 两个会话同时点优化时：
 *   1. A 写 clipFallback = snapA（用户原剪贴板 C0）
 *   2. B 写 clipFallback = snapB（此时剪贴板已被 A 覆盖成 T1，所以 snapB = T1）
 *   3. A 成功 → clipFallback = null
 *   4. B 超时 → restoreClipboardFallback() 拿到 null → 直接 return
 *   后果：B 已经把剪贴板覆盖成 T2，**没有任何人还原它**。
 *   反向交错也坏：A 超时会拿 **B 的快照（T1）** 还原回去，C0 丢了。
 *
 * 上层 polisher 的 inFlight 闸门是 per-sessionId 的，挡不住这个 ——
 * A 和 B 是不同会话。而它们写回的目标**其实是同一个物理输入框**，
 * 本来就不该并发。
 *
 * 所以在 UIA 这一层串行化：所有写回排队，一个个来。
 * 顺带也解决了 stop() 不中断在途子进程的问题 ——
 * 至少不会再出现两个孤儿 PowerShell 同时抢同一个剪贴板和输入框。
 */
let writeChain = Promise.resolve();

/** 把写回排队串行执行。无论前一个成功还是失败，都会继续处理队列里的下一个。 */
function serializeWrite(fn) {
  const run = writeChain.then(fn, fn);
  // 队列本身不能因为某一次失败而永久毒化：
  // 写一个永远不 reject 的尾巴，让后续任务能接上。
  writeChain = run.then(() => undefined, () => undefined);
  return run;
}

/**
 * 写回前先拿一份剪贴板快照。
 * 失败不阻塞主流程 —— 拿不到快照只是少一层保险，不该让优化功能直接不可用。
 */
async function snapshotClipboard() {
  try {
    const r = await runPs(CLIP_SNAPSHOT_SCRIPT, { timeoutMs: 5000, tag: "clip-snapshot" });
    const line = String(r?.raw || "").trim().split(/\r?\n/).filter((l) => l.startsWith("{")).pop();
    if (!line) return null;
    const j = JSON.parse(line);
    if (j?.ok !== true) return null;
    return { text: j.text === true, data: typeof j.data === "string" ? j.data : null, rich: j.rich === true };
  } catch {
    return null;
  }
}

/**
 * 兼底恢复：只在主脚本没能自己恢复时调用（即它被强杀了）。
 * 恢复不了非文本内容就明确报出来，不假装成功。
 */
async function restoreClipboardFallback() {
  const snap = clipFallback;
  if (!snap) return;
  clipFallback = null;
  try {
    if (!snap.text || typeof snap.data !== "string") {
      // 非文本快照重建不了。如实说，不静默。
      console.warn("[input-toolkit] 写回超时，剪贴板可能已变；非文本内容无法自动还原，请重新复制一次");
      return;
    }
    const text = Buffer.from(snap.data, "base64").toString("utf8");
    const script = [
      "Add-Type -AssemblyName System.Windows.Forms",
      "$b = '" + snap.data + "'",
      "try {",
      "  $t = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b))",
      "  [System.Windows.Forms.Clipboard]::SetText($t)",
      "  Write-Output '{\"ok\":true}'",
      "} catch { Write-Output '{\"ok\":false}' }",
    ].join("\n");
    await runPs(script, { timeoutMs: 5000, tag: "clip-restore" });
  } catch {
    /* 兼底也失败就算了：主路径已尽力，不在这里抛 */
  }
}

// ── 公开 API ────────────────────────────────────────────────────────────

/**
 * 读 HanaAgent 输入框文本(UIA TextPattern 全文)。
 * @param {object} [opts] { rescueFocus?: boolean, timeoutMs?: number, tag?: string }
 * @returns {Promise<{ok:true,value:string}|{ok:false,code:string,message:string}>}
 */
export async function readComposer(opts = {}) {
  const { rescueFocus = true, timeoutMs = TIMEOUT.read, tag = "read" } = opts;
  const r = await runPs(AGENT_SCRIPT, {
    timeoutMs,
    tag,
    request: { mode: "read", rescue: rescueFocus },
  });
  if (r && r.ok === true && typeof r.value === "string") return { ok: true, value: r.value };
  if (r && r.ok === false) return r;
  return { ok: false, code: "WIN32_ERROR", message: "unexpected empty response" };
}

/**
 * 后台轮询专用读:永远不做前台救援(不能抢焦点),超时更短。
 * 返回真实文本;输入框为空(占位符)时返回空串。
 */
export function readComposerTextOnly() {
  return readComposer({ rescueFocus: false, timeoutMs: TIMEOUT.watch, tag: "watch" });
}

/** 优化路径专用读:允许前台救援(与随后的写路径保持一致的窗口状态) */
export function readComposerForOptimize(opts = {}) {
  return readComposer({ rescueFocus: opts.rescueFocus !== false, timeoutMs: TIMEOUT.read, tag: "optimize-read" });
}

/** 兼容旧名:读当前输入框全文 */
export function readFocusedInputValue(opts = {}) {
  return readComposerForOptimize(opts);
}

/**
 * 真替换 HanaAgent 当前输入框文本。
 * @param {string} newText   要写入的文本(空串 = 清空)
 * @param {object} [opts]
 * @param {string|null} [opts.expect]  期望写前仍是这段原文;不一致则放弃写回(乐观锁)
 * @param {boolean} [opts.rescueFocus] 是否允许前台救援,默认 true
 * @returns {Promise<{ok:true,length:number,readback:string}|{ok:false,code:string,message:string}>}
 */
export async function setFocusedInputValue(newText, opts = {}) {
  if (typeof newText !== "string") {
    return { ok: false, code: "WIN32_ERROR", message: "newText must be string" };
  }
  const { expect = null, rescueFocus = true, timeoutMs = TIMEOUT.write } = opts;
  // 排队串行执行，理由见 writeChain 的声明。
  return serializeWrite(async () => {
    // 先拿兼底快照。主脚本一旦被 taskkill 强杀，它自己的 Restore-Clip 不会跑，
    // 用户的剪贴板就靠这一份兼底。拿不到快照不阻塞 —— 只是少一层保险。
    clipFallback = await snapshotClipboard();
    const r = await runPs(AGENT_SCRIPT, {
      timeoutMs,
      tag: "write",
      request: { mode: "write", text: newText, expect, rescue: rescueFocus },
    });
    if (r && r.ok === true) {
      // 成功路径：主脚本已自己恢复，兼底快照可以丢。
      clipFallback = null;
      return { ok: true, length: typeof r.length === "number" ? r.length : newText.length, readback: typeof r.readback === "string" ? r.readback : "" };
    }
    // 失败路径：分两种。只有 WIN32_TIMEOUT 意味着进程被强杀（主脚本没机会恢复），
    // 其余失败码主脚本都自己走过 Restore-Clip 并正常退出了。
    if (r?.code === "WIN32_TIMEOUT") {
      await restoreClipboardFallback();
    } else {
      clipFallback = null;
    }
    return r || { ok: false, code: "WIN32_ERROR", message: "unexpected empty response" };
  });
}

/** 仅用于诊断:导出实际执行的 PowerShell 脚本(脚本现在是静态的,与传参无关) */
export function _debugBuildScript() {
  return AGENT_SCRIPT;
}
