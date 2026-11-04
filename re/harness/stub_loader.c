/* A library that dlopens plugins, as Cinemo's libNmeBaseClasses.so does: its
 * dlopen is an undefined dlopen@GLIBC_2.2.5, resolved at load time. */
#include <dlfcn.h>
void *stub_load(const char *path) { return dlopen(path, RTLD_NOW | RTLD_GLOBAL); }
