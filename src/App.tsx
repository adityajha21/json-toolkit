import { useEffect, useMemo, useRef, useState } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import clsx from "clsx";

type Tool = "compare" | "viewer" | "xml" | "validator";

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
  const [activeTool, setActiveTool] = useState<Tool>("compare");
  const [compareMode, setCompareMode] = useState<"line" | "structure">("line");
  const [dark, setDark] = useState(true);
  const [input, setInput] = useState('{"name":"Aditya"}');
  const [compareLeft, setCompareLeft] = useState('{"a":1}');
  const [compareRight, setCompareRight] = useState('{"a":2}');
  const [output, setOutput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState("");

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

  const runValidate = () => {
    try {
      JSON.parse(input);
      setOutput("Valid JSON");
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

  const getStructureDiff = (left: any, right: any): string => {
    const lines: string[] = [];
    const walk = (o: any, p: string[] = []) => {
      if (o === null || typeof o !== "object") return;
      if (Array.isArray(o)) {
        o.forEach((v, i) => walk(v, [...p, `[${i}]`]));
        return;
      }
      Object.keys(o).forEach((key) => walk(o[key], [...p, key]));
    };

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
    return lines.length ? lines.join("\n") : "No structural differences";
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
          text = "Invalid JSON for structure compare";
        }
      }
    }
    navigator.clipboard.writeText(text).catch(() => {});
  };

  useEffect(() => {
    // keep output synced with input if not compare/viewer.
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
        setOutput("Valid JSON");
        setError(null);
      } catch (e: any) {
        setOutput("");
        setError(e.message);
      }
      setMarkers(input);
      return;
    }
    setMarkers(input);
  }, [input, activeTool]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey) {
        if (e.key === "Enter") {
          e.preventDefault();
          runMinify();
        } else if (e.key === "m") {
          e.preventDefault();
          runMinify();
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

  // ONLY UI CHANGES — LOGIC SAME

return (
  <div className={clsx("min-h-screen", dark ? "bg-[#0f172a] text-slate-100" : "bg-slate-100 text-slate-900")}>

    {/* HEADER */}
    <header className="sticky top-0 z-50 border-b border-slate-800 bg-slate-950 text-white">
      <div className="flex flex-col gap-2 px-6 py-2">
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-semibold">JSON Toolkit</h1>
          <div className="flex items-center gap-2 text-xs">
            <button
              onClick={() => setDark((d) => !d)}
              className="rounded border border-slate-700 px-2 py-1"
            >
              {dark ? "Light" : "Dark"}
            </button>
            <a href="https://github.com" target="_blank" rel="noreferrer" className="rounded border border-slate-700 px-2 py-1">
              GitHub
            </a>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs">
          {[
            { key: "compare", label: "Compare" },
            { key: "viewer", label: "Viewer" },
            { key: "validator", label: "Validator" },
            { key: "xml", label: "Convert XML" },
          ].map((tool) => (
            <button
              key={tool.key}
              onClick={() => setActiveTool(tool.key as Tool)}
              className={clsx(
                "px-2 py-1 rounded-md transition",
                activeTool === tool.key
                  ? "bg-indigo-500 text-white"
                  : "text-slate-300 hover:bg-slate-800 hover:text-white"
              )}
            >
              {tool.label}
            </button>
          ))}

          <button
            onClick={runMinify}
            className="rounded-md bg-indigo-500 px-2 py-1 text-white hover:bg-indigo-600"
          >
            Minify
          </button>
          <button
            onClick={runValidate}
            className="rounded-md bg-indigo-500 px-2 py-1 text-white hover:bg-indigo-600"
          >
            Validate
          </button>
          <label className="cursor-pointer rounded-md bg-slate-700 px-2 py-1 text-white hover:bg-slate-600">
            Upload
            <input
              type="file"
              className="hidden"
              onChange={(e) => e.target.files?.[0] && onUpload(e.target.files[0])}
            />
          </label>
          {activeTool === "xml" && (
            <button
              onClick={() => {
                try {
                  const data = jsonToXml(JSON.parse(input));
                  const blob = new Blob([data], { type: "application/xml" });
                  const link = document.createElement("a");
                  link.href = URL.createObjectURL(blob);
                  link.download = "output.xml";
                  link.click();
                  URL.revokeObjectURL(link.href);
                } catch (e: any) {
                  setError(e.message);
                }
              }}
              className="rounded-md bg-green-500 px-2 py-1 text-white hover:bg-green-600"
            >
              Download XML
            </button>
          )}

          <div className="ml-auto flex gap-3 text-xs text-slate-400">
            <span>{stats.size} bytes</span>
            <span>{stats.lines} lines</span>
            <span>{stats.keys} keys</span>
          </div>
        </div>
      </div>
    </header>

    {/* MAIN */}
    <main className="max-w-[calc(100%-2rem)] mx-auto px-0 py-3">

      {/* EDITOR */}
      {activeTool === "compare" ? (
        <>
          <div className="mb-4 grid grid-cols-1 gap-2 md:grid-cols-2">
            <div className="rounded-xl overflow-hidden border bg-slate-950">
              <div className="flex items-center justify-between border-b border-slate-700 bg-slate-900 px-2 py-1 text-xs font-semibold">
                <span>Left JSON</span>
                <button
                  onClick={() => navigator.clipboard.writeText(compareLeft)}
                  className="rounded bg-slate-700 px-2 py-0.5 text-[10px]"
                >
                  Copy
                </button>
              </div>
              <Editor
                height="360px"
                defaultLanguage="json"
                theme={dark ? "vs-dark" : "light"}
                value={compareLeft}
                onMount={onEditorMount}
                onChange={(value) => {
                  const v = value ?? "";
                  setCompareLeft(v);
                  setMarkers(v);
                }}
                options={{
                  minimap: { enabled: false },
                  wordWrap: "on",
                  fontSize: 13,
                  automaticLayout: true,
                }}
              />
            </div>
            <div className="rounded-xl overflow-hidden border bg-slate-950">
              <div className="flex items-center justify-between border-b border-slate-700 bg-slate-900 px-2 py-1 text-xs font-semibold">
                <span>Right JSON</span>
                <button
                  onClick={() => navigator.clipboard.writeText(compareRight)}
                  className="rounded bg-slate-700 px-2 py-0.5 text-[10px]"
                >
                  Copy
                </button>
              </div>
              <Editor
                height="360px"
                defaultLanguage="json"
                theme={dark ? "vs-dark" : "light"}
                value={compareRight}
                onChange={(v) => setCompareRight(v ?? "")}
                options={{ minimap: { enabled: false }, wordWrap: "on", fontSize: 13, automaticLayout: true }}
              />
            </div>
          </div>
          <div className="mb-3 flex items-center gap-2 text-xs">
          <span>Compare mode:</span>
          <button
            onClick={() => setCompareMode("line")}
            className={clsx(
              "rounded px-2 py-1",
              compareMode === "line" ? "bg-indigo-500 text-white" : "bg-slate-700 text-slate-100"
            )}
          >
            Line
          </button>
          <button
            onClick={() => setCompareMode("structure")}
            className={clsx(
              "rounded px-2 py-1",
              compareMode === "structure" ? "bg-indigo-500 text-white" : "bg-slate-700 text-slate-100"
            )}
          >
            Structure
          </button>
        </div>
        </>
      ) : (
        <div className="mb-4 rounded-xl overflow-hidden border bg-slate-950">
          <Editor
            height="420px"
            defaultLanguage="json"
            theme={dark ? "vs-dark" : "light"}
            value={input}
            onMount={onEditorMount}
            onChange={(value) => {
              const v = value ?? "";
              setInput(v);
              setMarkers(v);
            }}
            options={{
              minimap: { enabled: false },
              wordWrap: "on",
              fontSize: 13,
              automaticLayout: true,
            }}
          />
        </div>
      )}

      {/* ERROR */}
      {error && (
        <div className="mb-4 border border-red-500 bg-red-500/10 text-red-400 p-2 rounded-md">
          {error}
        </div>
      )}

      {/* OUTPUT */}
      <div className={clsx(
        "rounded-xl border p-4 shadow-md",
        dark
          ? "bg-slate-900 text-slate-100 border-slate-700"
          : "bg-white text-slate-900 border-slate-300"
      )}>

        {/* OUTPUT HEADER */}
        <div className="flex justify-between items-center mb-3">
          <h2 className="text-sm font-semibold">Output</h2>
          <div className="flex items-center gap-2">
            <input
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Search..."
              className="text-xs px-2 py-1 rounded bg-slate-800 border border-slate-600"
            />
            <button
              onClick={copyAllOutput}
              className="rounded bg-slate-700 px-2 py-1 text-xs"
            >
              Copy All Output
            </button>
          </div>
        </div>

        {/* OUTPUT BODY */}
        <div className="max-h-[400px] overflow-auto text-sm font-mono">
          {activeTool === "viewer" && parsedTree ? (
            <JsonTree data={parsedTree} search={searchTerm} />
          ) : activeTool === "compare" ? (
            compareMode === "line" ? (
              <div className="grid grid-cols-2 gap-2 text-xs">
                {["Left", "Right"].map((side, i) => (
                  <div key={side} className="bg-slate-800 p-2 rounded">
                    <strong className="text-indigo-400">{side}</strong>
                    {diffRows.map((row, idx) => (
                      <div
                        key={idx}
                        className={clsx(
                          "whitespace-pre-wrap",
                          row.state === "added" && "bg-emerald-600/25 text-emerald-100",
                          row.state === "removed" && "bg-rose-600/25 text-rose-100",
                          row.state === "changed" && "bg-amber-600/25 text-amber-100"
                        )}
                      >
                        {i === 0 ? row.left : row.right}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            ) : (
              <pre className="whitespace-pre-wrap text-xs">
                {(() => {
                  try {
                    const leftObj = JSON.parse(compareLeft);
                    const rightObj = JSON.parse(compareRight);
                    return getStructureDiff(leftObj, rightObj);
                  } catch (e) {
                    return "Invalid JSON for structural compare";
                  }
                })()}
              </pre>
            )
          ) : (
            <pre
              className={clsx("whitespace-pre-wrap", dark ? "text-slate-100" : "text-slate-900")}
              dangerouslySetInnerHTML={{
                __html: preparedOutput || "<i>No output</i>",
              }}
            />
          )}
        </div>
      </div>
    </main>

    {/* FOOTER */}
    <footer className={clsx(
      "border-t mt-8 py-6 px-4 text-center text-sm",
      dark
        ? "border-slate-700 bg-slate-950 text-slate-400"
        : "border-slate-200 bg-slate-50 text-slate-600"
    )}>
      <h3 className="font-semibold mb-3">Feedback & Contact</h3>
      <div className="flex flex-col gap-2 justify-center items-center">
        <p>We'd love to hear from you! Share your feedback to help us improve.</p>
        <div className="flex gap-4 justify-center flex-wrap">
          <a
            href="mailto:feedback@example.com"
            className={clsx(
              "hover:underline",
              dark ? "text-indigo-400 hover:text-indigo-300" : "text-indigo-600 hover:text-indigo-700"
            )}
          >
            📧 Email: aditaya.jha@gmail.com
          </a>
          <a
            href="https://github.com"
            target="_blank"
            rel="noopener noreferrer"
            className={clsx(
              "hover:underline",
              dark ? "text-indigo-400 hover:text-indigo-300" : "text-indigo-600 hover:text-indigo-700"
            )}
          >
            🐙 GitHub Issues
          </a>
          <a
            href="https://twitter.com"
            target="_blank"
            rel="noopener noreferrer"
            className={clsx(
              "hover:underline",
              dark ? "text-indigo-400 hover:text-indigo-300" : "text-indigo-600 hover:text-indigo-700"
            )}
          >
            𝕏 Twitter
          </a>
        </div>
      </div>
      <p className="text-xs mt-4 opacity-70">© 2026 JSON Toolkit. All rights reserved.</p>
    </footer>
  </div>
);
}

export default App;
