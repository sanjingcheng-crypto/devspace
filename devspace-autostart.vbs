' devspace-autostart.vbs — 登录自启入口（无窗口）
' 放在「启动」文件夹后，Windows 登录时自动拉起 start-all.mjs，
' 从而自动建立隧道 + 启动 devspace serve（保留 ownerToken）。
'
' 注意：下面两个路径是本机专属，换机器/换用户请按需修改：
'   1) 托管 Node 路径（WorkBuddy 自带，版本号可能不同）
'   2) start-all.mjs 所在路径（即本仓库根目录）
Set o = CreateObject("WScript.Shell")
o.Run """C:\Users\Administrator\.workbuddy\binaries\node\versions\22.22.2\node.exe"" ""C:\Jim\devspace\start-all.mjs""", 0, False
