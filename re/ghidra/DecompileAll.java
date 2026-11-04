// Decompile every function into one C file (first script argument), for
// grepping across the program: re/run.sh decompile-all.
// @category idrive
import ghidra.app.decompiler.DecompInterface;
import ghidra.app.decompiler.DecompileResults;
import ghidra.app.script.GhidraScript;
import ghidra.program.model.listing.Function;
import java.io.*;

public class DecompileAll extends GhidraScript {
    @Override
    public void run() throws Exception {
        PrintWriter w = new PrintWriter(new FileWriter(getScriptArgs()[0]));
        DecompInterface d = new DecompInterface();
        d.openProgram(currentProgram);
        int ok = 0, bad = 0;
        for (Function f : currentProgram.getFunctionManager().getFunctions(true)) {
            if (monitor.isCancelled()) break;
            if (f.isThunk() || f.isExternal()) continue;
            DecompileResults r = d.decompileFunction(f, 60, monitor);
            w.println("// ===== " + f.getName() + " @ " + f.getEntryPoint());
            if (r.decompileCompleted()) { w.println(r.getDecompiledFunction().getC()); ok++; }
            else { w.println("// failed: " + r.getErrorMessage()); bad++; }
        }
        d.dispose();
        w.close();
        println("DecompileAll: " + ok + " decompiled, " + bad + " failed");
    }
}
