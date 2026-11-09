// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
//
// A .NET Framework 4 program with a window, as an old .NET game is (Wine
// Mono runs it: proton/share/wine/mono). Logs which runtime it is on and its
// bitness to T_LOG, then redraws its window from a timer (the frames wl-sink
// counts) and logs once it has drawn 40 times. test/build_win.sh builds it
// with Mono's mcs: t_net.exe (AnyCPU: 64-bit) and t_net32.exe (x86).
using System;
using System.Drawing;
using System.IO;
using System.Windows.Forms;

class TNet : Form
{
    int frames;

    static void Log(string s)
    {
        string p = Environment.GetEnvironmentVariable("T_LOG");
        if (p != null) File.AppendAllText(p, s + "\n");
    }

    TNet()
    {
        Text = "t_net";
        ClientSize = new Size(320, 200);
        Timer t = new Timer();
        t.Interval = 50;
        t.Tick += (o, e) => { frames++; Invalidate(); if (frames == 40) Log("t_net: drew 40 frames"); };
        t.Start();
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        e.Graphics.Clear(frames % 2 == 0 ? Color.OrangeRed : Color.SteelBlue);
    }

    [STAThread]
    static void Main()
    {
        bool mono = Type.GetType("Mono.Runtime") != null;
        Log("t_net: .NET " + Environment.Version + ", " + (IntPtr.Size == 8 ? "64-bit" : "32-bit") + ", " + (mono ? "Wine Mono" : "not Mono"));
        Application.Run(new TNet());
    }
}
