using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Threading;
using System.Windows.Forms;

namespace LongNiangUninstall
{
    /// <summary>
    /// 龙娘跑团 · 卸载器
    ///
    /// 放在安装目录一级目录里，双击就用。
    /// 会：关掉还在跑的进程 → 可选备份存档到桌面 → 删安装目录 → 删桌面快捷方式 → 删 %LOCALAPPDATA% 的记录。
    ///
    /// 因为要删掉自己所在目录，启动时先把自己复制到临时目录再跑。
    /// 参数：--yes 跳过确认（用默认选项：备份存档 + 删快捷方式）
    /// </summary>
    static class Program
    {
        [STAThread]
        static void Main(string[] args)
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            string installDir = null;
            bool fromTemp = false;
            bool silent = false;

            foreach (var a in args)
            {
                if (a == "--from-temp") fromTemp = true;
                else if (a == "--yes") silent = true;
                else if (!a.StartsWith("--")) installDir = a.Trim('"');
            }

            if (!fromTemp)
            {
                string self = Assembly.GetExecutingAssembly().Location;
                installDir = Path.GetDirectoryName(self);
                string temp = Path.Combine(Path.GetTempPath(), "ln-uninstall-" + Guid.NewGuid().ToString("N") + ".exe");
                try
                {
                    File.Copy(self, temp, true);
                    Process.Start(new ProcessStartInfo(temp, "--from-temp " + (silent ? "--yes " : "") + "\"" + installDir + "\"")
                    {
                        UseShellExecute = false,
                    });
                }
                catch (Exception ex)
                {
                    MessageBox.Show("卸载器没法启动：" + ex.Message, "龙娘跑团", MessageBoxButtons.OK, MessageBoxIcon.Error);
                }
                return;
            }

            if (string.IsNullOrEmpty(installDir) || !Directory.Exists(installDir))
            {
                MessageBox.Show("找不到安装目录：" + installDir, "龙娘跑团", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return;
            }

            Application.Run(new UninstallForm(installDir, silent));
        }
    }

    class UninstallForm : Form
    {
        readonly string dir;
        readonly bool silent;
        readonly CheckBox keepSave;
        readonly CheckBox removeShortcut;
        readonly Label status;

        public UninstallForm(string installDir, bool silent)
        {
            dir = installDir;
            this.silent = silent;

            Text = "卸载 龙娘跑团";
            ClientSize = new Size(620, 400);
            StartPosition = FormStartPosition.CenterScreen;
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            MinimizeBox = false;
            BackColor = Color.FromArgb(11, 16, 32);
            ForeColor = Color.FromArgb(231, 236, 247);
            Font = new Font("Microsoft YaHei UI", 9f);

            var title = new Label
            {
                Text = "要卸载龙娘跑团吗",
                Font = new Font("Microsoft YaHei UI", 16f, FontStyle.Bold),
                AutoSize = true,
                Location = new Point(28, 24),
            };
            Controls.Add(title);

            var path = new Label
            {
                Text = "安装目录：" + dir,
                ForeColor = Color.FromArgb(140, 152, 179),
                AutoSize = false,
                Bounds = new Rectangle(28, 72, 560, 40),
            };
            Controls.Add(path);

            keepSave = new CheckBox
            {
                Text = "先把存档备份到桌面（推荐）",
                AutoSize = true,
                Checked = true,
                Location = new Point(30, 124),
            };
            Controls.Add(keepSave);

            var hint = new Label
            {
                Text = "存档是 data\\game.db，里面有你的账号、对局和剧本进度。不勾就一起删掉。",
                ForeColor = Color.FromArgb(140, 152, 179),
                AutoSize = false,
                Bounds = new Rectangle(48, 150, 540, 40),
            };
            Controls.Add(hint);

            removeShortcut = new CheckBox
            {
                Text = "同时删掉桌面快捷方式「龙娘跑团」",
                AutoSize = true,
                Checked = true,
                Location = new Point(30, 196),
            };
            Controls.Add(removeShortcut);

            status = new Label
            {
                Text = "",
                ForeColor = Color.FromArgb(190, 200, 220),
                Bounds = new Rectangle(28, 232, 560, 60),
            };
            Controls.Add(status);

            var go = new Button
            {
                Text = "删除",
                Bounds = new Rectangle(470, 330, 120, 38),
                BackColor = Color.FromArgb(90, 32, 40),
                ForeColor = Color.White,
                FlatStyle = FlatStyle.Flat,
            };
            go.Click += delegate { DoUninstall(go); };
            Controls.Add(go);

            var cancel = new Button
            {
                Text = "取消",
                Bounds = new Rectangle(370, 330, 90, 38),
                FlatStyle = FlatStyle.Flat,
                ForeColor = Color.FromArgb(200, 210, 230),
            };
            cancel.Click += delegate { Close(); };
            Controls.Add(cancel);

            if (silent)
            {
                Shown += delegate { DoUninstall(go); };
            }
        }

        void SetStatus(string text)
        {
            if (InvokeRequired)
            {
                BeginInvoke(new Action(delegate { SetStatus(text); }));
                return;
            }
            status.Text = text;
            Application.DoEvents();
        }

        void DoUninstall(Button go)
        {
            if (!silent)
            {
                var ok = MessageBox.Show(this,
                    "确认删除？\n\n" + dir + "\n\n删掉以后没法从回收站恢复（文件是直接删的）。",
                    "龙娘跑团", MessageBoxButtons.YesNo, MessageBoxIcon.Warning);
                if (ok != DialogResult.Yes) return;
            }

            go.Enabled = false;

            var t = new Thread(delegate ()
            {
                try
                {
                    SetStatus("正在关掉还在跑的程序…");
                    KillRunning();

                    if (keepSave.Checked)
                    {
                        SetStatus("正在备份存档…");
                        BackupSave();
                    }

                    if (removeShortcut.Checked)
                    {
                        SetStatus("正在删桌面快捷方式…");
                        RemoveShortcut();
                    }

                    SetStatus("正在删安装目录…");
                    string problem = DeleteDirectoryWithRetry(dir);

                    SetStatus("正在清理安装记录…");
                    DeleteStateDir();

                    if (problem == null)
                    {
                        SetStatus("删干净了。");
                        if (!silent)
                        {
                            MessageBox.Show(this, "已经卸载完了。\n\n存档备份（如果勾了）在桌面上。",
                                "龙娘跑团", MessageBoxButtons.OK, MessageBoxIcon.Information);
                        }
                    }
                    else
                    {
                        SetStatus("还有文件删不掉：" + problem);
                        if (!silent)
                        {
                            MessageBox.Show(this,
                                "目录里还有东西删不掉：\n" + problem +
                                "\n\n可能还有进程在跑，试试重启电脑以后再删一次。",
                                "龙娘跑团", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                        }
                    }
                }
                catch (Exception ex)
                {
                    SetStatus("出错了：" + ex.Message);
                }
                finally
                {
                    if (InvokeRequired) BeginInvoke(new Action(Close));
                    else Close();
                }
            });
            t.IsBackground = true;
            t.Start();
        }

        /// <summary>关掉从这个目录启动的 LongNiang.exe / node.exe。</summary>
        void KillRunning()
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
                        // 读不到路径或者已经退了，跳过
                    }
                }
            }
            Thread.Sleep(600);
        }

        void BackupSave()
        {
            string data = Path.Combine(dir, "ai-trpg-V1.0.2", "data");
            if (!Directory.Exists(data)) return;

            string target = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory),
                "龙娘跑团-存档-" + DateTime.Now.ToString("yyyyMMdd-HHmm"));
            Directory.CreateDirectory(target);
            CopyDir(data, target);
        }

        static void CopyDir(string from, string to)
        {
            foreach (var f in Directory.GetFiles(from))
                File.Copy(f, Path.Combine(to, Path.GetFileName(f)), true);
            foreach (var d in Directory.GetDirectories(from))
            {
                string sub = Path.Combine(to, Path.GetFileName(d));
                Directory.CreateDirectory(sub);
                CopyDir(d, sub);
            }
        }

        void RemoveShortcut()
        {
            try
            {
                string lnk = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "龙娘跑团.lnk");
                if (File.Exists(lnk)) File.Delete(lnk);
            }
            catch { }
        }

        void DeleteStateDir()
        {
            try
            {
                string state = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "LongNiangTRPG");
                if (Directory.Exists(state)) Directory.Delete(state, true);
            }
            catch { }
        }

        /// <summary>删目录，被占用就等一会儿重试。返回删不掉的文件（都删掉就是 null）。</summary>
        static string DeleteDirectoryWithRetry(string path)
        {
            for (int i = 0; i < 12; i++)
            {
                try
                {
                    Directory.Delete(path, true);
                    return null;
                }
                catch
                {
                    Thread.Sleep(700);
                }
            }

            try
            {
                var rest = new List<string>();
                foreach (var f in Directory.GetFiles(path, "*", SearchOption.AllDirectories))
                {
                    rest.Add(f);
                    if (rest.Count >= 5) break;
                }
                return rest.Count > 0 ? string.Join("\n", rest) : "（目录还在，但看不出来是哪几个文件）";
            }
            catch
            {
                return "（目录还在，但看不出来是哪几个文件）";
            }
        }
    }
}
