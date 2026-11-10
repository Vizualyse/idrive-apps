// Pre-analysis: don't let Ghidra decide that a program's own functions never
// return. BMW's audio manager plugin logs through CAmDltControlLogger, whose
// instance() Ghidra took for non-returning: every function then ended at its
// first log call. Only the imported, known non-returning functions (exit,
// abort, __stack_chk_fail, ...) stay so.
// @category idrive
import ghidra.app.script.GhidraScript;

public class KeepReturns extends GhidraScript {
    @Override
    public void run() throws Exception {
        setAnalysisOption(currentProgram, "Non-Returning Functions - Discovered", "false");
        println("KeepReturns: non-returning discovery off");
    }
}
