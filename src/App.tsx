import { useEffect, useMemo, useRef, useState } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import clsx from "clsx";

type Tool = "formatter" | "compare" | "viewer" | "xml" | "validator" | "class-to-json" | "update-data";

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#039;");

const getErrorPosition = (json: string, message: string) => {
  const lineColumn = /at line (\d+) column (\d+)/i.exec(message);
  if (lineColumn) {
    return { line: Number(lineColumn[1]), column: Number(lineColumn[2]) };
  }

  const pos = /position (\d+)/i.exec(message);
  if (pos) {
    const index = Number(pos[1]);
    const before = json.slice(0, index);
    const line = before.split("\n").length;
    const col = index - (before.lastIndexOf("\n") || -1);
    return { line, column: Math.max(1, col) };
  }

  return { line: 1, column: 1 };
};

const jsonToXml = (value: any, tag = "root"): string => {
  if (value == null) return `<${tag}/>`;
  if (typeof value !== "object") return `<${tag}>${escapeHtml(String(value))}</${tag}>`;
  if (Array.isArray(value)) return value.map((v) => jsonToXml(v, tag)).join("");
  return `<${tag}>${Object.entries(value).map(([k, v]) => jsonToXml(v, k)).join("")}</${tag}>`;
};

const JsonTree = ({ data, search = "" }: { data: any; search?: string }) => {
  if (data == null || typeof data !== "object") {
    const raw = escapeHtml(String(data));
    if (!search) return <span>{raw}</span>;
    const re = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    const highlighted = raw.replace(re, (match) => `<mark class='bg-yellow-300 text-slate-900'>${match}</mark>`);
    return <span dangerouslySetInnerHTML={{ __html: highlighted }} />;
  }

  return (
    <ul className="space-y-1 pl-4">
      {Array.isArray(data)
        ? data.map((item, idx) => (
            <li key={idx} className="flex gap-1">
              <span className="text-indigo-300">-</span>
              <JsonTree data={item} search={search} />
            </li>
          ))
        : Object.entries(data).map(([key, value]) => (
            <li key={key} className="flex gap-1">
              <span className="text-indigo-300">{key}:</span>
              <JsonTree data={value} search={search} />
            </li>
          ))}
    </ul>
  );
};

const getDiff = (left: string, right: string) => {
  const leftLines = left.split(/\r?\n/);
  const rightLines = right.split(/\r?\n/);
  const rows: Array<{ left: string; right: string; state: "same" | "added" | "removed" | "changed" }> = [];
  const max = Math.max(leftLines.length, rightLines.length);
  for (let i = 0; i < max; i++) {
    const l = leftLines[i] ?? "";
    const r = rightLines[i] ?? "";
    if (l === r) rows.push({ left: l, right: r, state: "same" });
    else if (!l && r) rows.push({ left: l, right: r, state: "added" });
    else if (l && !r) rows.push({ left: l, right: r, state: "removed" });
    else rows.push({ left: l, right: r, state: "changed" });
  }
  return rows;
};

const countKeys = (obj: any): number => {
  if (obj == null || typeof obj !== "object") return 0;
  if (Array.isArray(obj)) return obj.reduce((sum: number, item: any) => sum + countKeys(item), 0);
  return Object.keys(obj).length + Object.values(obj).reduce((sum: number, val: any) => sum + countKeys(val), 0);
};

function App() {
  const [activeTool, setActiveTool] = useState<Tool>("formatter");
  const [compareMode] = useState<"line" | "structure">("line");
  const [dark, setDark] = useState(true);
  const [input, setInput] = useState('{\n  "name": "John Doe",\n  "email": "john@example.com"\n}');
  const [compareLeft, setCompareLeft] = useState('{"a":1}');
  const [compareRight] = useState('{"a":2}');
  const [output, setOutput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [classInput, setClassInput] = useState("");

  const editorRef = useRef<any>(null);
  const monacoRef = useRef<any>(null);

  const setMarkers = (jsonText: string) => {
    if (!editorRef.current || !monacoRef.current) return;
    const model = editorRef.current.getModel();
    if (!model) return;

    try {
      JSON.parse(jsonText);
      monacoRef.current.editor.setModelMarkers(model, "json-toolkit", []);
      setError(null);
    } catch (e: any) {
      const { line, column } = getErrorPosition(jsonText, e.message || "Invalid JSON");
      monacoRef.current.editor.setModelMarkers(model, "json-toolkit", [
        {
          severity: monacoRef.current.MarkerSeverity.Error,
          message: e.message || "Syntax error",
          startLineNumber: line,
          startColumn: column,
          endLineNumber: line,
          endColumn: Math.min(column + 2, 999),
        },
      ]);
      setError(e.message);
    }
  };

  const onEditorMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;
    setMarkers(input);
  };

  const runMinify = () => {
    try {
      const parsed = JSON.parse(input);
      setOutput(JSON.stringify(parsed));
      setError(null);
    } catch (e: any) {
      setOutput("");
      setError(e.message);
    }
    setMarkers(input);
  };

  const runFormat = () => {
    try {
      const parsed = JSON.parse(input);
      const formatted = JSON.stringify(parsed, null, 2);
      setInput(formatted);
      setOutput(formatted);
      setError(null);
    } catch (e: any) {
      setOutput("");
      setError(e.message);
    }
    setMarkers(input);
  };

  const downloadOutput = () => {
    const content = output || input;
    const data = new Blob([content], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(data);
    link.download = "json-toolkit-output.json";
    link.click();
    URL.revokeObjectURL(link.href);
  };

  const runValidate = () => {
    try {
      JSON.parse(input);
      setOutput("✓ Valid JSON");
      setError(null);
    } catch (e: any) {
      setOutput("");
      setError(e.message);
    }
    setMarkers(input);
  };

  const runXml = () => {
    try {
      const parsed = JSON.parse(input);
      setOutput(jsonToXml(parsed));
      setError(null);
    } catch (e: any) {
      setOutput("");
      setError(e.message);
    }
    setMarkers(input);
  };

  const onUpload = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      const text = reader.result as string;
      setInput(text);
      setMarkers(text);
    };
    reader.readAsText(file);
  };

  const classToJson = (classCode: string): string => {
    try {
      const propertyRegex = /(?:public|private|protected)?\s+(?:readonly\s+)?(\w+):\s*([^;]+);/g;
      const properties: { [key: string]: any } = {};
      
      let match;
      while ((match = propertyRegex.exec(classCode)) !== null) {
        const [, propName, propType] = match;
        let defaultValue: any;
        
        if (propType.includes('string') || propType.includes('String')) {
          defaultValue = "test_string";
        } else if (propType.includes('number') || propType.includes('Number')) {
          defaultValue = 123;
        } else if (propType.includes('boolean') || propType.includes('Boolean')) {
          defaultValue = true;
        } else if (propType.includes('Date')) {
          defaultValue = new Date().toISOString();
        } else if (propType.includes('[]') || propType.includes('Array')) {
          defaultValue = [];
        } else {
          defaultValue = null;
        }
        
        properties[propName] = defaultValue;
      }
      
      return JSON.stringify(properties, null, 2);
    } catch (e) {
      return '{"error": "Invalid class syntax"}';
    }
  };

  const getStructureDiff = (left: any, right: any): string => {
    const lines: string[] = [];

    const compare = (a: any, b: any, p: string[] = []) => {
      if (a === b) return;
      if (a === undefined) {
        lines.push(`+ ${[...p].join(".")}: ${JSON.stringify(b)}`);
        return;
      }
      if (b === undefined) {
        lines.push(`- ${[...p].join(".")}: ${JSON.stringify(a)}`);
        return;
      }
      if (typeof a !== typeof b) {
        lines.push(`~ ${[...p].join(".")}: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`);
        return;
      }
      if (typeof a !== "object" || a === null || b === null) {
        if (a !== b) lines.push(`~ ${[...p].join(".")}: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`);
        return;
      }
      if (Array.isArray(a) && Array.isArray(b)) {
        const max = Math.max(a.length, b.length);
        for (let i = 0; i < max; i++) compare(a[i], b[i], [...p, `${i}`]);
        return;
      }
      const keys = Array.from(new Set([...Object.keys(a), ...Object.keys(b)]));
      keys.forEach((key) => compare(a[key], b[key], [...p, key]));
    };

    compare(left, right);
    return lines.length ? lines.join("\n") : "No differences";
  };

  const copyAllOutput = () => {
    let text = output;
    if (activeTool === "compare") {
      if (compareMode === "line") {
        text = diffRows.map((row) => `${row.left}\n${row.right}`).join("\n");
      } else {
        try {
          const a = JSON.parse(compareLeft);
          const b = JSON.parse(compareRight);
          text = getStructureDiff(a, b);
        } catch {
          text = "Invalid JSON";
        }
      }
    }
    navigator.clipboard.writeText(text).catch(() => {});
  };

  useEffect(() => {
    if (activeTool === "xml") {
      runXml();
      return;
    }
    if (activeTool === "viewer") {
      setOutput("");
      setError(null);
      setMarkers(input);
      return;
    }
    if (activeTool === "compare") {
      setOutput("");
      setError(null);
      setMarkers(input);
      return;
    }
    if (activeTool === "validator") {
      try {
        JSON.parse(input);
        setOutput("✓ Valid JSON");
        setError(null);
      } catch (e: any) {
        setOutput("");
        setError(e.message);
      }
      setMarkers(input);
      return;
    }
    if (activeTool === "class-to-json") {
      setOutput("");
      setError(null);
      return;
    }
    if (activeTool === "update-data") {
      setOutput("");
      setError(null);
      return;
    }
    setMarkers(input);
  }, [input, activeTool]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey) {
        if (e.key === "Enter") {
          e.preventDefault();
          runFormat();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [input]);

  const preparedOutput = useMemo(() => {
    if (!searchTerm) return escapeHtml(output);
    const re = new RegExp(searchTerm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    return escapeHtml(output).replace(re, (m) => `<mark class='bg-yellow-300 text-slate-900'>${m}</mark>`);
  }, [output, searchTerm]);

  const diffRows = useMemo(() => {
    try {
      const left = JSON.stringify(JSON.parse(compareLeft), null, 2);
      const right = JSON.stringify(JSON.parse(compareRight), null, 2);
      return getDiff(left, right);
    } catch {
      return [];
    }
  }, [compareLeft, compareRight]);

  const parsedTree = useMemo(() => {
    try {
      return JSON.parse(input);
    } catch {
      return null;
    }
  }, [input]);

  const stats = useMemo(() => {
    try {
      const parsed = JSON.parse(input);
      const size = new Blob([JSON.stringify(parsed)]).size;
      const lines = JSON.stringify(parsed, null, 2).split("\n").length;
      const keys = countKeys(parsed);
      return { size, lines, keys };
    } catch {
      return { size: 0, lines: 0, keys: 0 };
    }
  }, [input]);

  return (
    <div className={clsx("flex flex-col h-screen", dark ? "bg-slate-950 text-slate-100" : "bg-white text-slate-900")}>
      {/* HEADER */}
      <header className={clsx("border-b px-4 py-3", dark ? "border-slate-800 bg-slate-950/80" : "border-slate-200 bg-white/80")}>
        <div className="max-w-7xl mx-auto">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <div className="text-2xl font-bold">{"{}"}</div>
              <div>
                <h1 className="font-bold text-lg">JSON Toolkit</h1>
                <p className={clsx("text-xs", dark ? "text-slate-500" : "text-slate-500")}>Free online JSON tools</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button onClick={() => setDark(!dark)} className={clsx("px-3 py-1 rounded text-sm", dark ? "bg-slate-800 hover:bg-slate-700" : "bg-slate-100 hover:bg-slate-200")}>
                {dark ? "☀️" : "🌙"}
              </button>
              <a href="https://github.com" target="_blank" rel="noreferrer" className="text-slate-500 hover:text-slate-300">
                GitHub
              </a>
            </div>
          </div>

          <nav className="flex gap-2 overflow-x-auto pb-1 -mx-4 px-4">
            {[
              { key: "formatter", label: "Formatter" },
              { key: "validator", label: "Validator" },
              { key: "compare", label: "Compare" },
              { key: "viewer", label: "Viewer" },
              { key: "xml", label: "XML" },
              { key: "class-to-json", label: "Class to JSON" },
              { key: "update-data", label: "Update Data" },
            ].map((tool) => (
              <button
                key={tool.key}
                onClick={() => setActiveTool(tool.key as Tool)}
                className={clsx(
                  "px-3 py-1 rounded text-sm font-medium whitespace-nowrap",
                  activeTool === tool.key
                    ? "bg-indigo-500 text-white"
                    : clsx(dark ? "text-slate-400 hover:text-slate-200" : "text-slate-600 hover:text-slate-900")
                )}
              >
                {tool.label}
              </button>
            ))}
          </nav>
        </div>
      </header>

      {/* TOOLBAR */}
      <div className={clsx("border-b px-4 py-2", dark ? "border-slate-800 bg-slate-950/50" : "border-slate-200 bg-slate-50")}>
        <div className="max-w-7xl mx-auto flex gap-2 items-center flex-wrap">
          <button onClick={runFormat} className="px-3 py-1 rounded text-sm bg-indigo-500 text-white hover:bg-indigo-600 font-medium">
            Format
          </button>
          <button onClick={runMinify} className="px-3 py-1 rounded text-sm bg-indigo-500 text-white hover:bg-indigo-600 font-medium">
            Minify
          </button>
          <button onClick={runValidate} className={clsx("px-3 py-1 rounded text-sm font-medium", dark ? "bg-slate-800 text-slate-100 hover:bg-slate-700" : "bg-slate-200 text-slate-900 hover:bg-slate-300")}>
            Validate
          </button>
          <button onClick={copyAllOutput} className={clsx("px-3 py-1 rounded text-sm font-medium", dark ? "bg-slate-800 text-slate-100 hover:bg-slate-700" : "bg-slate-200 text-slate-900 hover:bg-slate-300")}>
            Copy
          </button>
          <button onClick={downloadOutput} className={clsx("px-3 py-1 rounded text-sm font-medium", dark ? "bg-slate-800 text-slate-100 hover:bg-slate-700" : "bg-slate-200 text-slate-900 hover:bg-slate-300")}>
            Download
          </button>
          <label className={clsx("px-3 py-1 rounded text-sm font-medium cursor-pointer", dark ? "bg-slate-800 text-slate-100 hover:bg-slate-700" : "bg-slate-200 text-slate-900 hover:bg-slate-300")}>
            Upload
            <input type="file" className="hidden" onChange={(e) => e.target.files?.[0] && onUpload(e.target.files[0])} />
          </label>

          <div className="ml-auto flex gap-4 text-xs text-slate-500">
            <span>{stats.size} bytes</span>
            <span>{stats.lines} lines</span>
            <span>{stats.keys} keys</span>
          </div>
        </div>
      </div>

      {/* ERROR */}
      {error && (
        <div className="px-4 py-2 bg-red-500/10 border-b border-red-500/50 text-red-400 text-sm">
          {error}
        </div>
      )}

      {/* MAIN CONTENT */}
      <div className="flex-1 overflow-hidden flex max-w-7xl w-full mx-auto px-4 py-3 gap-3">
        {/* LEFT PANE */}
        <div className={clsx("flex-1 rounded-lg border overflow-hidden flex flex-col", dark ? "border-slate-800 bg-slate-950/50" : "border-slate-200 bg-slate-50")}>
          <div className={clsx("px-4 py-2 border-b text-sm font-semibold", dark ? "border-slate-800 bg-slate-900/50" : "border-slate-200 bg-slate-100")}>
            {activeTool === "compare" ? "Left JSON" : activeTool === "class-to-json" ? "Class Input" : "JSON Input"}
          </div>
          <div className="flex-1 overflow-hidden">
            {activeTool === "compare" ? (
              <Editor
                height="100%"
                defaultLanguage="json"
                theme={dark ? "vs-dark" : "light"}
                value={compareLeft}
                onMount={onEditorMount}
                onChange={(value) => {
                  setCompareLeft(value ?? "");
                  setMarkers(value ?? "");
                }}
                options={{ minimap: { enabled: false }, wordWrap: "on", fontSize: 12, automaticLayout: true }}
              />
            ) : activeTool === "class-to-json" ? (
              <textarea
                value={classInput}
                onChange={(e) => setClassInput(e.target.value)}
                placeholder="public class User {
  public name: string;
  public age: number;
}"
                className={clsx("w-full h-full p-4 font-mono text-sm outline-none", dark ? "bg-transparent text-slate-100" : "bg-transparent text-slate-900")}
              />
            ) : (
              <Editor
                height="100%"
                defaultLanguage="json"
                theme={dark ? "vs-dark" : "light"}
                value={input}
                onMount={onEditorMount}
                onChange={(value) => {
                  setInput(value ?? "");
                  setMarkers(value ?? "");
                }}
                options={{ minimap: { enabled: false }, wordWrap: "on", fontSize: 12, automaticLayout: true }}
              />
            )}
          </div>
        </div>

        {/* RIGHT PANE */}
        <div className={clsx("flex-1 rounded-lg border overflow-hidden flex flex-col", dark ? "border-slate-800 bg-slate-950/50" : "border-slate-200 bg-slate-50")}>
          <div className={clsx("px-4 py-2 border-b text-sm font-semibold flex items-center justify-between", dark ? "border-slate-800 bg-slate-900/50" : "border-slate-200 bg-slate-100")}>
            <span>{activeTool === "compare" ? "Right JSON" : "Formatted Output"}</span>
            <input
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Search..."
              className={clsx("px-2 py-1 rounded text-xs outline-none", dark ? "bg-slate-800 border-0 text-slate-100" : "bg-white border border-slate-300")}
            />
          </div>
          <div className={clsx("flex-1 overflow-auto p-4 font-mono text-sm", dark ? "bg-slate-950/30" : "bg-slate-50")}>
            {activeTool === "viewer" && parsedTree ? (
              <JsonTree data={parsedTree} search={searchTerm} />
            ) : activeTool === "compare" ? (
              compareMode === "line" ? (
                <div className="grid grid-cols-1 gap-4">
                  <div>
                    <strong className="text-indigo-400">Left</strong>
                    {diffRows.map((row, idx) => (
                      <div
                        key={idx}
                        className={clsx("whitespace-pre-wrap text-xs p-1 rounded", row.state === "added" && "bg-emerald-600/25", row.state === "removed" && "bg-rose-600/25", row.state === "changed" && "bg-amber-600/25")}
                      >
                        {row.left}
                      </div>
                    ))}
                  </div>
                  <div>
                    <strong className="text-indigo-400">Right</strong>
                    {diffRows.map((row, idx) => (
                      <div
                        key={idx}
                        className={clsx("whitespace-pre-wrap text-xs p-1 rounded", row.state === "added" && "bg-emerald-600/25", row.state === "removed" && "bg-rose-600/25", row.state === "changed" && "bg-amber-600/25")}
                      >
                        {row.right}
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <pre className="whitespace-pre-wrap text-xs text-slate-300">
                  {(() => {
                    try {
                      return getStructureDiff(JSON.parse(compareLeft), JSON.parse(compareRight));
                    } catch {
                      return "Invalid JSON";
                    }
                  })()}
                </pre>
              )
            ) : activeTool === "class-to-json" ? (
              <div>
                <button onClick={() => {
                  const result = classToJson(classInput);
                  setOutput(result);
                  setError(null);
                }} className="px-3 py-1 rounded text-sm bg-indigo-500 text-white hover:bg-indigo-600 font-medium mb-3">
                  Convert to JSON
                </button>
                <pre className={clsx("whitespace-pre-wrap text-xs", dark ? "text-slate-100" : "text-slate-900")}>
                  {output || "Click convert to generate JSON..."}
                </pre>
              </div>
            ) : (
              <pre className={clsx("whitespace-pre-wrap text-xs", dark ? "text-slate-100" : "text-slate-900")} dangerouslySetInnerHTML={{ __html: preparedOutput || "Output will appear here..." }} />
            )}
          </div>
        </div>
      </div>

      {/* FOOTER */}
      <footer className={clsx("border-t px-4 py-2 text-center text-xs", dark ? "border-slate-800 text-slate-500" : "border-slate-200 text-slate-600")}>
        © 2026 JSON Toolkit | <a href="mailto:feedback@example.com" className="hover:underline">Feedback</a>
      </footer>
    </div>
  );
}

export default App;
