// Export where the CarPlay alternate-screen vocabulary is used, for
// re/run.sh ghidra. Off-car, read-only on the program.
//
// Writes a TSV (first script argument):
//   program  <name>  functions=<n>
//   kw       <keyword> <string addr> <ref from> <function@entry> <string>
//   scalar   <function@entry> <values>     functions using both 110 and 111
//                                          (AirPlay screen stream types)
//   func     <name> <entry> <size>         every function, for diffing builds
// @category idrive
import ghidra.app.script.GhidraScript;
import ghidra.program.model.address.Address;
import ghidra.program.model.listing.*;
import ghidra.program.model.mem.Memory;
import ghidra.program.model.mem.MemoryBlock;
import ghidra.program.model.scalar.Scalar;
import ghidra.program.model.symbol.Reference;
import ghidra.program.model.symbol.ReferenceManager;
import java.io.*;
import java.util.*;

public class ExportAltScreen extends GhidraScript {

    static final String[] KEYWORDS = {
        "altScreen", "viewAreas", "viewArea", "safeArea", "adjacentViewAreas", "initialViewArea",
        "updateViewArea", "displayFeatures", "displays", "widthPixels", "heightPixels", "maxFPS",
        "primaryInputDevice", "initialURL", "altScreenSuggestUIURLs", "enabledFeatures",
        "suggestUI", "showUI", "stopUI", "changeMapZoomLevel", "instrumentcluster",
        "streamConnectionID", "DataStream", "AirPlayStreamKey", "screenType",
        "SetInitialInfoResponse", "GetDisplaySource", "ShowUI", "ForceKeyframe",
        "AlternateDisplay", "ICSafeAreaProvider", "requestStream", "SuggestUi", "avb://",
        "heightPhysical", "widthPhysical", "DataStream-Salt", "AirPlayStreamIV", "ScreenStream",
        "SessionScreen", "streams", "dataPort",
    };
    static final int MAX_HITS = 200;

    String readStr(Memory mem, Address a) {
        StringBuilder sb = new StringBuilder();
        try {
            for (int i = 0; i < 160; i++) {
                int c = mem.getByte(a.add(i)) & 0xff;
                if (c < 0x20 || c >= 0x7f) break;
                sb.append((char) c);
            }
        } catch (Exception e) { /* end of block */ }
        return sb.toString().replace('\t', ' ');
    }

    Address stringStart(Memory mem, Address hit, Address floor) {
        Address a = hit;
        try {
            for (int i = 0; i < 200 && a.compareTo(floor) > 0; i++) {
                int c = mem.getByte(a.subtract(1)) & 0xff;
                if (c < 0x20 || c >= 0x7f) break;
                a = a.subtract(1);
            }
        } catch (Exception e) { /* start of block */ }
        return a;
    }

    String fn(FunctionManager fm, Address at) {
        Function f = fm.getFunctionContaining(at);
        return f == null ? "-" : f.getName(true) + "@" + f.getEntryPoint();
    }

    @Override
    public void run() throws Exception {
        String[] args = getScriptArgs();
        PrintWriter w = new PrintWriter(new FileWriter(args.length > 0 ? args[0] : "altscreen.tsv"));
        Memory mem = currentProgram.getMemory();
        ReferenceManager rm = currentProgram.getReferenceManager();
        FunctionManager fm = currentProgram.getFunctionManager();
        w.println("program\t" + currentProgram.getName() + "\tfunctions=" + fm.getFunctionCount());

        for (String kw : KEYWORDS) {
            byte[] b = kw.getBytes("US-ASCII");
            int hits = 0;
            for (MemoryBlock blk : mem.getBlocks()) {
                if (!blk.isInitialized() || blk.isExecute()) continue;
                Address a = blk.getStart();
                while (hits < MAX_HITS && !monitor.isCancelled()) {
                    Address hit = mem.findBytes(a, blk.getEnd(), b, null, true, monitor);
                    if (hit == null) break;
                    hits++;
                    Address s = stringStart(mem, hit, blk.getStart());
                    Set<Address> refsTo = new LinkedHashSet<>(Arrays.asList(s, hit));
                    // Cinemo's constant strings: an 8-byte header 56 07 01 00 ff ff ff 7f,
                    // then the text. Code references the header.
                    try {
                        Address h = s.subtract(8);
                        if (mem.getLong(h) == 0x7fffffff00010756L) refsTo.add(h);
                    } catch (Exception e) { /* start of block */ }
                    boolean any = false;
                    for (Address t : refsTo) {
                        for (Reference r : rm.getReferencesTo(t)) {
                            w.println("kw\t" + kw + "\t" + s + "\t" + r.getFromAddress() + "\t"
                                + fn(fm, r.getFromAddress()) + "\t" + readStr(mem, s));
                            any = true;
                        }
                    }
                    if (!any) w.println("kw\t" + kw + "\t" + s + "\t-\t-\t" + readStr(mem, s));
                    if (hit.compareTo(blk.getEnd()) >= 0) break;
                    a = hit.add(1);
                }
            }
        }

        Map<Function, TreeSet<Long>> scal = new LinkedHashMap<>();
        InstructionIterator it = currentProgram.getListing().getInstructions(true);
        while (it.hasNext() && !monitor.isCancelled()) {
            Instruction ins = it.next();
            for (int i = 0; i < ins.getNumOperands(); i++) {
                for (Object o : ins.getOpObjects(i)) {
                    if (!(o instanceof Scalar)) continue;
                    long v = ((Scalar) o).getUnsignedValue();
                    if (v != 110 && v != 111) continue;
                    Function f = fm.getFunctionContaining(ins.getAddress());
                    if (f != null) scal.computeIfAbsent(f, k -> new TreeSet<>()).add(v);
                }
            }
        }
        for (Map.Entry<Function, TreeSet<Long>> e : scal.entrySet()) {
            if (e.getValue().size() == 2) {
                w.println("scalar\t" + e.getKey().getName(true) + "@" + e.getKey().getEntryPoint() + "\t" + e.getValue());
            }
        }

        for (Function f : fm.getFunctions(true)) {
            w.println("func\t" + f.getName(true) + "\t" + f.getEntryPoint() + "\t" + f.getBody().getNumAddresses());
        }
        w.close();
    }
}
