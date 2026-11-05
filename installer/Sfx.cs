using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace LongNiangSetup
{
    /// <summary>
    /// 龙娘跑团启动器 · 安装器
    ///
    /// 流程：免责声明（勾了才能继续）→ 选目录 → 解压 payload → 建桌面快捷方式 → 启动。
    /// 同一版本不重复解压；data 目录不在包里，升级不动存档。
    /// </summary>
    static class Program
    {
        public const string PayloadVersion = "1.6.3";
        public const string AppTitle = "龙娘跑团 启动器";

        [STAThread]
        static void Main(string[] args)
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            string forcedDir = null;
            bool choose = false;
            foreach (var a in args)
            {
                if (a == "--choose") choose = true;
                else if (a.StartsWith("--install-dir=")) forcedDir = a.Substring("--install-dir=".Length).Trim('"');
            }

            Application.Run(new SetupForm(forcedDir, choose));
        }
    }

    class SetupForm : Form
    {
        readonly string forcedDir;

        Panel pageDisclaimer;
        Panel pageInstall;
        CheckBox agree;
        CheckBox makeShortcut;
        Button next;
        Label statusLabel;
        ProgressBar bar;
        TextBox dirBox;

        string installDir;

        public SetupForm(string forcedDir, bool forceChoose)
        {
            this.forcedDir = forcedDir;

            Text = Program.AppTitle;
            ClientSize = new Size(660, 560);
            StartPosition = FormStartPosition.CenterScreen;
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            MinimizeBox = false;
            BackColor = Color.FromArgb(11, 16, 32);
            ForeColor = Color.FromArgb(231, 236, 247);
            Font = new Font("Microsoft YaHei UI", 9f);

            BuildDisclaimer();
            BuildInstall();

            Controls.Add(pageInstall);
            Controls.Add(pageDisclaimer);
            pageDisclaimer.BringToFront();
        }

        /* ---------------- 第一页：免责声明 ---------------- */

        void BuildDisclaimer()
        {
            pageDisclaimer = new Panel { Dock = DockStyle.Fill, BackColor = Color.FromArgb(11, 16, 32) };

            var title = new Label
            {
                Text = "使用前请阅读",
                Font = new Font("Microsoft YaHei UI", 16f, FontStyle.Bold),
                ForeColor = Color.FromArgb(231, 236, 247),
                AutoSize = true,
                Location = new Point(28, 22),
            };
            pageDisclaimer.Controls.Add(title);

            var text = new RichTextBox
            {
                ReadOnly = true,
                BorderStyle = BorderStyle.None,
                BackColor = Color.FromArgb(16, 22, 40),
                ForeColor = Color.FromArgb(200, 210, 230),
                Font = new Font("Microsoft YaHei UI", 9.5f),
                Bounds = new Rectangle(28, 62, 604, 380),
                ScrollBars = RichTextBoxScrollBars.Vertical,
                Text = DisclaimerText(),
                DetectUrls = false,
            };
            pageDisclaimer.Controls.Add(text);

            agree = new CheckBox
            {
                Text = "我已阅读并同意以上内容",
                ForeColor = Color.FromArgb(231, 236, 247),
                AutoSize = true,
                Location = new Point(30, 456),
            };
            agree.CheckedChanged += delegate { next.Enabled = agree.Checked; };
            pageDisclaimer.Controls.Add(agree);

            next = new Button
            {
                Text = "同意并继续",
                Bounds = new Rectangle(486, 486, 146, 38),
                Enabled = false,
                BackColor = Color.FromArgb(40, 52, 80),
                ForeColor = Color.White,
                FlatStyle = FlatStyle.Flat,
            };
            next.Click += delegate { ShowInstallPage(); };
            pageDisclaimer.Controls.Add(next);

            var quit = new Button
            {
                Text = "退出",
                Bounds = new Rectangle(392, 486, 84, 38),
                FlatStyle = FlatStyle.Flat,
                ForeColor = Color.FromArgb(200, 210, 230),
            };
            quit.Click += delegate { Close(); };
            pageDisclaimer.Controls.Add(quit);
        }

        static string DisclaimerText()
        {
            return
"【1】这是什么\n" +
"一个单机跑团工具的启动器。它会在你选的文件夹里放一份游戏服务端，用你自己的 DeepSeek API 密钥跑 AI 主持人。\n\n" +
"【2】谁做的\n" +
"启动器  Mui001_aic    B站 uid 38393386    GitHub  Mui001 / Mui001-aic\n" +
"游戏本体  花崎诗奏      B站 uid 397694843   GitHub 仓库  bwxnQAQ/longniang-trpg\n" +
"启动器是我另外写的程序，不属于游戏本体；游戏本体按 AGPL-3.0 分发，源码在上面的仓库。\n\n" +
"【3】发布渠道\n" +
"只在启动器作者的 B站 账号 Mui001_aic 发布。\n" +
"⚠ 从其他任何地方（网盘转存、群文件、二次打包）拿到的安装包，我无法确认真伪，\n" +
"   也不对其安全性负责。请认准发布来源。\n\n" +
"【4】它会在你电脑上做什么\n" +
"· 解压到你自己选的文件夹\n" +
"· 在 %LOCALAPPDATA%\\LongNiangTRPG 记一个安装位置\n" +
"· 联网：调用 DeepSeek 接口（花你自己的额度）、检查 GitHub 上的新版本\n" +
"· 不写注册表、不装服务、不收集个人信息\n\n" +
"【5】需要你自己把关的\n" +
"· API 密钥是你自己的，费用也是你自己的\n" +
"· AI 生成的内容不保证正确，跑团内容请自行判断\n" +
"· 卸载 = 用安装目录里的「卸载龙娘跑团.exe」，或者手动删掉安装目录\n\n" +
"【6】免责\n" +
"本软件按你拿到的样子提供，不做任何保证：不保证一定能用、不保证不出错、不保证不丢存档。\n" +
"因使用本软件造成的任何损失，作者不承担责任。\n";
        }

        /* ---------------- 第二页：选目录 + 解压 ---------------- */

        void BuildInstall()
        {
            pageInstall = new Panel { Dock = DockStyle.Fill, BackColor = Color.FromArgb(11, 16, 32), Visible = false };

            var title = new Label
            {
                Text = "安装到哪",
                Font = new Font("Microsoft YaHei UI", 16f, FontStyle.Bold),
                ForeColor = Color.FromArgb(231, 236, 247),
                AutoSize = true,
                Location = new Point(28, 22),
            };
            pageInstall.Controls.Add(title);

            var hint = new Label
            {
                Text = "路径里不要有中文和空格（游戏对非 ASCII 路径有问题，会崩）。",
                ForeColor = Color.FromArgb(140, 152, 179),
                AutoSize = true,
                Location = new Point(28, 62),
            };
            pageInstall.Controls.Add(hint);

            dirBox = new TextBox
            {
                Bounds = new Rectangle(28, 92, 500, 28),
                BackColor = Color.FromArgb(16, 22, 40),
                ForeColor = Color.FromArgb(231, 236, 247),
                BorderStyle = BorderStyle.FixedSingle,
            };
            pageInstall.Controls.Add(dirBox);

            var browse = new Button
            {
                Text = "浏览…",
                Bounds = new Rectangle(538, 92, 94, 28),
                FlatStyle = FlatStyle.Flat,
                ForeColor = Color.FromArgb(200, 210, 230),
            };
            browse.Click += delegate
            {
                using (var dlg = new FolderBrowserDialog())
                {
                    dlg.Description = "选一个没有中文、没有空格的文件夹";
                    if (dlg.ShowDialog() == DialogResult.OK) dirBox.Text = dlg.SelectedPath;
                }
            };
            pageInstall.Controls.Add(browse);

            statusLabel = new Label
            {
                Text = "",
                ForeColor = Color.FromArgb(190, 200, 220),
                Bounds = new Rectangle(28, 140, 604, 60),
            };
            pageInstall.Controls.Add(statusLabel);

            bar = new ProgressBar
            {
                Bounds = new Rectangle(28, 200, 604, 18),
                Style = ProgressBarStyle.Continuous,
            };
            pageInstall.Controls.Add(bar);

            makeShortcut = new CheckBox
            {
                Text = "在桌面创建快捷方式「龙娘跑团」",
                ForeColor = Color.FromArgb(231, 236, 247),
                AutoSize = true,
                Location = new Point(30, 236),
                Checked = true,
            };
            pageInstall.Controls.Add(makeShortcut);

            var go = new Button
            {
                Text = "开始安装",
                Bounds = new Rectangle(486, 486, 146, 38),
                BackColor = Color.FromArgb(40, 52, 80),
                ForeColor = Color.White,
                FlatStyle = FlatStyle.Flat,
            };
            go.Click += delegate { StartInstall(go); };
            pageInstall.Controls.Add(go);

            var back = new Button
            {
                Text = "返回",
                Bounds = new Rectangle(392, 486, 84, 38),
                FlatStyle = FlatStyle.Flat,
                ForeColor = Color.FromArgb(200, 210, 230),
            };
            back.Click += delegate
            {
                pageInstall.Visible = false;
                pageDisclaimer.Visible = true;
            };
            pageInstall.Controls.Add(back);
        }

        void ShowInstallPage()
        {
            dirBox.Text = forcedDir ?? ReadLastDir() ?? DefaultDir();
            pageDisclaimer.Visible = false;
            pageInstall.Visible = true;
            pageInstall.BringToFront();
        }

        static string DefaultDir()
        {
            return Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "Programs", "LongNiangTRPG");
        }

        static string StateDir
        {
            get
            {
                return Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "LongNiangTRPG");
            }
        }

        string ReadLastDir()
        {
            try
            {
                string file = Path.Combine(StateDir, "install.ini");
                if (!File.Exists(file)) return null;
                foreach (var line in File.ReadAllLines(file))
                {
                    if (line.StartsWith("dir="))
                    {
                        string v = line.Substring(4).Trim();
                        if (Directory.Exists(v)) return v;
                    }
                }
            }
            catch { }
            return null;
        }

        void SaveLastDir(string dir)
        {
            try
            {
                Directory.CreateDirectory(StateDir);
                File.WriteAllText(Path.Combine(StateDir, "install.ini"), "dir=" + dir + "\r\n");
            }
            catch { }
        }

        static bool IsAsciiPath(string p)
        {
            foreach (char c in p)
                if (c > 127 || c == ' ') return false;
            return true;
        }

        void StartInstall(Button go)
        {
            string dir = dirBox.Text.Trim();
            if (dir.Length == 0)
            {
                MessageBox.Show(this, "先选一个文件夹", Program.AppTitle, MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }
            if (!IsAsciiPath(dir))
            {
                MessageBox.Show(this, "路径里有中文或空格，请换一个（比如 D:\\LongNiangTRPG）",
                    Program.AppTitle, MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }

            installDir = dir;
            go.Enabled = false;
            dirBox.Enabled = false;

            var t = new Thread(delegate () { DoInstall(); });
            t.IsBackground = true;
            t.Start();
        }

        void SetStatus(string text, int percent)
        {
            if (InvokeRequired)
            {
                BeginInvoke(new Action(delegate () { SetStatus(text, percent); }));
                return;
            }
            statusLabel.Text = text;
            bar.Value = Math.Max(0, Math.Min(100, percent));
        }

        void DoInstall()
        {
            try
            {
                SetStatus("准备中…", 0);
                Directory.CreateDirectory(installDir);

                string marker = Path.Combine(installDir, ".payload-version");
                bool upToDate = File.Exists(marker)
                    && File.Exists(Path.Combine(installDir, "electron", "LongNiang.exe"))
                    && File.ReadAllText(marker).Trim() == Program.PayloadVersion;

                if (!upToDate)
                {
                    // 上次装完还开着的进程会锁住 electron 里的文件，升级会解压失败
                    SetStatus("检查有没有还在跑的龙娘跑团…", 3);
                    KillRunningUnder(installDir);
                    ExtractPayload();
                }
                else
                {
                    SetStatus("已经是这个版本了，跳过解压", 100);
                }

                SaveLastDir(installDir);
                Done();
            }
            catch (Exception ex)
            {
                SetStatus("安装失败：" + ex.Message, 0);
            }
        }

        /// <summary>关掉从这个目录启动的 LongNiang.exe / node.exe，不然解压会失败。</summary>
        static void KillRunningUnder(string dir)
        {
            foreach (var name in new[] { "LongNiang", "node" })
            {
                foreach (var p in Process.GetProcessesByName(name))
                {
                    try
                    {
                        string exe = p.MainModule == null ? null : p.MainModule.FileName;
                        if (exe != null && exe.StartsWith(dir, StringComparison.OrdinalIgnoreCase))
                        {
                            p.Kill();
                            p.WaitForExit(5000);
                        }
                    }
                    catch
                    {
                        // 读不到路径就跳过
                    }
                }
            }
            Thread.Sleep(500);
        }

        void ExtractPayload()
        {
            string temp = Path.Combine(Path.GetTempPath(), "longniang-payload-" + Guid.NewGuid().ToString("N") + ".zip");

            SetStatus("正在取出安装文件…", 2);
            using (Stream s = Assembly.GetExecutingAssembly().GetManifestResourceStream("payload.zip"))
            {
                if (s == null) throw new Exception("安装包损坏（找不到内嵌文件）");
                using (FileStream f = File.Create(temp)) s.CopyTo(f);
            }

            try
            {
                using (var zip = ZipFile.OpenRead(temp))
                {
                    int total = zip.Entries.Count;
                    int done = 0;

                    foreach (var entry in zip.Entries)
                    {
                        string dest = Path.Combine(installDir, entry.FullName.Replace('/', Path.DirectorySeparatorChar));

                        // 目录条目可能用 / 也可能用 \ 结尾，两种都要当目录
                        if (entry.FullName.EndsWith("/") || entry.FullName.EndsWith("\\"))
                        {
                            Directory.CreateDirectory(dest);
                        }
                        else
                        {
                            Directory.CreateDirectory(Path.GetDirectoryName(dest));
                            entry.ExtractToFile(dest, true);
                        }

                        done++;
                        if (done % 20 == 0)
                            SetStatus(string.Format("正在解压… {0}/{1}", done, total), 5 + (int)(done * 90.0 / total));
                    }
                }

                File.WriteAllText(Path.Combine(installDir, ".payload-version"), Program.PayloadVersion);
            }
            finally
            {
                try { File.Delete(temp); } catch { }
            }
        }

        void Done()
        {
            if (InvokeRequired)
            {
                BeginInvoke(new Action(Done));
                return;
            }

            if (makeShortcut != null && makeShortcut.Checked)
            {
                SetStatus("正在创建桌面快捷方式…", 100);
                CreateDesktopShortcut();
            }

            SetStatus("装好了，正在启动…", 100);
            Launch();
            Close();
        }

        /// <summary>桌面快捷方式：交给 wscript 建（进程里直接调 COM 会把这个程序搞崩）。</summary>
        void CreateDesktopShortcut()
        {
            string target = Path.Combine(installDir, "electron", "LongNiang.exe");
            if (!File.Exists(target)) return;

            string desktop = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
            string lnk = Path.Combine(desktop, "龙娘跑团.lnk");
            string vbs = Path.Combine(Path.GetTempPath(), "longniang-sc-" + Guid.NewGuid().ToString("N") + ".vbs");

            try
            {
                var sb = new StringBuilder();
                sb.AppendLine("Set s = CreateObject(\"WScript.Shell\")");
                sb.AppendLine("Set l = s.CreateShortcut(\"" + lnk + "\")");
                sb.AppendLine("l.TargetPath = \"" + target + "\"");
                sb.AppendLine("l.WorkingDirectory = \"" + Path.Combine(installDir, "electron") + "\"");
                sb.AppendLine("l.IconLocation = \"" + target + ",0\"");
                sb.AppendLine("l.Description = \"龙娘跑团\"");
                sb.AppendLine("l.Save");
                File.WriteAllText(vbs, sb.ToString(), Encoding.Default);

                var psi = new ProcessStartInfo(vbs);
                psi.UseShellExecute = true;
                psi.WindowStyle = ProcessWindowStyle.Hidden;
                using (var p = Process.Start(psi))
                {
                    if (p != null) p.WaitForExit(8000);
                }
            }
            catch (Exception ex)
            {
                try
                {
                    File.AppendAllText(Path.Combine(Path.GetTempPath(), "longniang-install.log"),
                        DateTime.Now.ToString("s") + " 快捷方式失败: " + ex.Message + "\r\n");
                }
                catch { }
            }
            finally
            {
                try { File.Delete(vbs); } catch { }
            }
        }

        void Launch()
        {
            try
            {
                var psi = new ProcessStartInfo(Path.Combine(installDir, "electron", "LongNiang.exe"));
                psi.WorkingDirectory = installDir;
                psi.UseShellExecute = false;
                // 有这个环境变量的话，Electron 会当成 node 跑（没有窗口、没有日志）
                psi.EnvironmentVariables.Remove("ELECTRON_RUN_AS_NODE");
                Process.Start(psi);
            }
            catch (Exception ex)
            {
                MessageBox.Show(this, "启动失败：" + ex.Message + "\n\n手动双击安装目录里 electron\\LongNiang.exe 试试。",
                    Program.AppTitle, MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
        }
    }
}
