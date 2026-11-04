// Decompile functions to C for reading, for re/run.sh decompile.
// Arguments: <out file> <hex address>... (each address is inside the function).
// @category idrive
import ghidra.app.decompiler.DecompInterface;
import ghidra.app.decompiler.DecompileResults;
import ghidra.app.script.GhidraScript;
import ghidra.program.model.listing.Function;
import java.io.*;

public class Decompile extends GhidraScript {
    @Override
    public void run() throws Exception {
        String[] args = getScriptArgs();
        PrintWriter w = new PrintWriter(new FileWriter(args[0]));
        DecompInterface d = new DecompInterface();
        d.openProgram(currentProgram);
        for (int i = 1; i < args.length; i++) {
            if (args[i].startsWith("s:")) {   // s:<addr>: the C string there, or what a pointer there points to
                ghidra.program.model.address.Address a = toAddr(args[i].substring(2));
                StringBuilder sb = new StringBuilder();
                for (int k = 0; k < 120; k++) {
                    int c = getByte(a.add(k)) & 0xff;
                    if (c == 0) break;
                    sb.append(c >= 0x20 && c < 0x7f ? (char) c : '.');
                }
                String ptr = "";
                try {
                    ghidra.program.model.address.Address p = toAddr(getLong(a));
                    StringBuilder ps = new StringBuilder();
                    for (int k = 0; k < 120; k++) {
                        int c = getByte(p.add(k)) & 0xff;
                        if (c == 0) break;
                        ps.append(c >= 0x20 && c < 0x7f ? (char) c : '.');
                    }
                    ptr = " -> " + p + " \"" + ps + "\"";
                } catch (Exception e) { /* not a pointer */ }
                w.println("// string " + a + " \"" + sb + "\"" + ptr);
                continue;
            }
            Function f = getFunctionContaining(toAddr(args[i]));
            if (f == null) { w.println("// no function at " + args[i]); continue; }
            DecompileResults r = d.decompileFunction(f, 120, monitor);
            w.println("// ===== " + f.getName() + " @ " + f.getEntryPoint());
            w.println(r.decompileCompleted() ? r.getDecompiledFunction().getC() : "// failed: " + r.getErrorMessage());
        }
        d.dispose();
        w.close();
    }
}
