# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Yousaf Khan
#
# Makes patches/wine-no-ia32.patch: edits GE-Proton's dlls/ntdll/unix/signal_x86_64.c
# (argv[1]) so 32-bit programs run on a kernel without IA32 emulation (the
# unit's: knowledge/games.md). Every edit must find its text exactly once.
# Regenerate for a new Proton: copy the file twice, run this on one, diff -u.
import sys

p = sys.argv[1]
s = open(p).read()


def edit(old, new):
    global s
    n = s.count(old)
    if n != 1:
        sys.exit('edit: found %d times:\n%s' % (n, old))
    s = s.replace(old, new)


# 1. no set_thread_area through int $0x80: alloc_fs_sel goes
start = s.index('extern int alloc_fs_sel( int sel, void *base );')
end = s.index('struct modify_ldt_s')
s = s[:start] + (
    '/* No GDT selector for the 32-bit %fs (set_thread_area): it is only an i386\n'
    ' * system call, which faults on a kernel without IA32 emulation. Each 32-bit\n'
    ' * thread gets an LDT selector of its own instead (signal_alloc_thread), set\n'
    ' * with the 64-bit modify_ldt. */\n\n') + s[end:]

# 2. modify_ldt: the 64-bit system call
start = s.index('extern int modify_ldt( struct modify_ldt_s *ldt );')
end = s.index('#ifndef PR_SET_SYSCALL_USER_DISPATCH')
s = s[:start] + (
    'static int modify_ldt( struct modify_ldt_s *ldt )\n'
    '{\n'
    '    /* func 0x11: write an entry (new mode) */\n'
    '    return syscall( SYS_modify_ldt, 0x11, ldt, sizeof(*ldt) ) ? -errno : 0;\n'
    '}\n\n') + s[end:]

edit('#include <asm/prctl.h>\n', '#include <asm/prctl.h>\n#include <errno.h>\n')

# 3. signal handlers: the thread's own selector, glibc's %fs base restored
edit('        if (fs32_sel) arch_prctl( ARCH_SET_FS, thread_data->pthread_teb );',
     '        if (thread_data->fs) arch_prctl( ARCH_SET_FS, thread_data->pthread_teb );')
edit('        if (fs32_sel) __asm__ volatile( "movw %0,%%fs" :: "r" (fs32_sel) );',
     '        if (thread_data->fs) __asm__ volatile( "movw %0,%%fs" :: "r" ((USHORT)thread_data->fs) );')

# 4. no GDT selector at process start: fs32_sel stays 0
edit('        cs32_sel = 0x23;\n        fs32_sel = alloc_fs_sel( -1, wow_teb );\n',
     '        cs32_sel = 0x23;\n')

# 5. thread start: keep glibc's %fs base for the dispatcher and the handlers
edit('    if (fs32_sel)\n    {\n        arch_prctl( ARCH_GET_FS, &thread_data->pthread_teb );\n'
     '        alloc_fs_sel( fs32_sel >> 3, get_wow_teb( teb ));\n    }\n',
     '    if (thread_data->fs) arch_prctl( ARCH_GET_FS, &thread_data->pthread_teb );\n')

if 'int $0x80' in s:
    sys.exit('edit: int $0x80 still in the file')
open(p, 'w').write(s)
print('signal_x86_64.c: 64-bit modify_ldt, an LDT %fs per 32-bit thread')
