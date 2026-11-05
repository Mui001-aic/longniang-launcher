' 双击这个文件启动龙娘跑团启动器（不会弹出黑色窗口）。
Option Explicit

Dim fso, sh, here, rc
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)

Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = here

If Not fso.FileExists(fso.BuildPath(here, "launcher\server.mjs")) Then
  MsgBox "启动器文件不完整：找不到 launcher\server.mjs。" & vbCrLf & vbCrLf & _
         "请把整个文件夹完整解压以后再双击。", 16, "龙娘跑团启动器"
  WScript.Quit 1
End If

' 先确认装了 Node.js
rc = sh.Run("cmd /c node -v >nul 2>nul", 0, True)
If rc <> 0 Then
  MsgBox "没有找到 Node.js。" & vbCrLf & vbCrLf & _
         "请先到 https://nodejs.org 装 LTS 版本（一路下一步就行），装完再双击这个文件。", 16, "龙娘跑团启动器"
  WScript.Quit 1
End If

' 用 node 启动控制面板（窗口隐藏，界面用 Edge 的应用模式打开）
sh.Run "node """ & fso.BuildPath(here, "launcher\server.mjs") & """", 0, False
