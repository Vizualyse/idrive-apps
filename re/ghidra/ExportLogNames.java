// Recover names in a stripped build of Apple's AirPlay receiver code from its
// log strings, for re/run.sh ghidra. Off-car, read-only on the program.
//
// Apple's receiver code logs its own function names (e.g.
// "AirPlayReceiverSessionScreen_ProcessFrames"). Every string in a data block
// that looks like one identifier is listed with the functions that reference it:
//   name  <string> <nrefs> <function@entry>[,<function@entry>...]
// A string referenced from one function only is a strong name candidate for it
// (or for a function it logs on behalf of). Output: the first script argument.
// @category idrive
import ghidra.app.script.GhidraScript;
import ghidra.program.model.address.Address;
import ghidra.program.model.listing.Function;
import ghidra.program.model.listing.FunctionManager;
import ghidra.program.model.mem.Memory;
import ghidra.program.model.mem.MemoryBlock;
import ghidra.program.model.symbol.Reference;
import java.io.*;
import java.util.*;
import java.util.regex.Pattern;

public class ExportLogNames extends GhidraScript {

    // One identifier, optionally prefixed by '_', with at least one capital
    // after the first letter (CamelCase) or an underscore part: skips words.
    static final Pattern IDENT = Pattern.compile("_?[A-Za-z][A-Za-z0-9]*([A-Z][A-Za-z0-9]*|_[A-Za-z0-9]+)+");

    @Override
    public void run() throws Exception {
        String[] args = getScriptArgs();
        PrintWriter w = new PrintWriter(new FileWriter(args.length > 0 ? args[0] : "lognames.tsv"));
        Memory mem = currentProgram.getMemory();
        FunctionManager fm = currentProgram.getFunctionManager();
        int n = 0;
        for (MemoryBlock blk : mem.getBlocks()) {
            if (!blk.isInitialized() || blk.isExecute()) continue;
            byte[] data = new byte[(int) blk.getSize()];
            blk.getBytes(blk.getStart(), data);
            int i = 0;
            while (i < data.length) {
                int s = i;
                while (i < data.length && data[i] >= 0x21 && data[i] < 0x7f) i++;
                int len = i - s;
                if (len >= 8 && len <= 120 && i < data.length && data[i] == 0) {
                    String str = new String(data, s, len, "US-ASCII");
                    if (IDENT.matcher(str).matches()) {
                        Address a = blk.getStart().add(s);
                        TreeSet<String> fns = new TreeSet<>();
                        int refs = 0;
                        for (Reference r : getReferencesTo(a)) {
                            refs++;
                            Function f = fm.getFunctionContaining(r.getFromAddress());
                            fns.add(f == null ? "?" + r.getFromAddress() : f.getName(true) + "@" + f.getEntryPoint());
                        }
                        if (refs > 0) {
                            w.println("name\t" + str + "\t" + refs + "\t" + String.join(",", fns));
                            n++;
                        }
                    }
                }
                i++;
            }
        }
        w.close();
        println("ExportLogNames: " + n + " referenced identifier strings");
    }
}
