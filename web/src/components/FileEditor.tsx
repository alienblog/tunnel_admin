import { useEffect, useRef } from 'react';
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView, lineNumbers, highlightActiveLine } from '@codemirror/view';
import { history, historyKeymap, defaultKeymap, indentWithTab } from '@codemirror/commands';
import { keymap } from '@codemirror/view';
import { StreamLanguage, type StreamParser } from '@codemirror/language';
import { oneDark } from '@codemirror/theme-one-dark';

/**
 * 按文件扩展名加载语法高亮（动态 import，按需分包）
 * 常见格式：js/ts/jsx/tsx、json、python、html/vue、css、markdown、yaml、sql、xml/svg、
 * java、c/c++、rust、go、toml、shell/bash、ini/conf、dockerfile、gitignore 等
 */
type LangLoader = () => Promise<Extension | null>;

const legacy = (mod: Promise<Record<string, StreamParser<unknown>>>, key: string): LangLoader => async () => {
  const m = await mod;
  return StreamLanguage.define(m[key] as StreamParser<unknown>);
};

const LANG_LOADERS: Array<[RegExp, LangLoader]> = [
  [/\.(tsx?|mts|cts|jsx?|mjs|cjs)$/i, () => import('@codemirror/lang-javascript').then((m) => m.javascript({ jsx: true, typescript: true }))],
  [/\.json$/i, () => import('@codemirror/lang-json').then((m) => m.json())],
  [/\.py$/i, () => import('@codemirror/lang-python').then((m) => m.python())],
  [/\.(html?|vue|svelte)$/i, () => import('@codemirror/lang-html').then((m) => m.html())],
  [/\.css$/i, () => import('@codemirror/lang-css').then((m) => m.css())],
  [/\.(md|markdown)$/i, () => import('@codemirror/lang-markdown').then((m) => m.markdown())],
  [/\.ya?ml$/i, () => import('@codemirror/lang-yaml').then((m) => m.yaml())],
  [/\.sql$/i, () => import('@codemirror/lang-sql').then((m) => m.sql())],
  [/\.(xml|svg|plist)$/i, () => import('@codemirror/lang-xml').then((m) => m.xml())],
  [/\.java$/i, () => import('@codemirror/lang-java').then((m) => m.java())],
  [/\.(c|h|cc|hh|cpp|hpp|cxx)$/i, () => import('@codemirror/lang-cpp').then((m) => m.cpp())],
  [/\.rs$/i, () => import('@codemirror/lang-rust').then((m) => m.rust())],
  [/\.go$/i, () => import('@codemirror/lang-go').then((m) => m.go())],
  [/\\.toml$/i, legacy(import('@codemirror/legacy-modes/mode/toml'), 'toml')],
  [/\\.(sh|bash|zsh|ksh)$/i, legacy(import('@codemirror/legacy-modes/mode/shell'), 'shell')],
  [/\\.(ini|conf|cfg|properties)$/i, legacy(import('@codemirror/legacy-modes/mode/properties'), 'properties')],
  [/\\.(dockerfile|Dockerfile)$/i, legacy(import('@codemirror/legacy-modes/mode/dockerfile'), 'dockerFile')],
  [/\\.gitignore$/i, legacy(import('@codemirror/legacy-modes/mode/nginx'), 'nginx')],
];

export async function loadLangForFile(name: string): Promise<Extension | null> {
  for (const [re, load] of LANG_LOADERS) {
    if (re.test(name)) {
      try {
        return await load();
      } catch {
        return null;
      }
    }
  }
  return null;
}

/**
 * CodeMirror 6 文件编辑器：语法高亮 + 行号 + 历史 + 只读模式。
 * 内容由 CodeMirror 内部管理（不受外部 state 驱动），通过 onChange 通知修改。
 */
export default function FileEditor({
  initialContent,
  filename,
  readOnly,
  onChange,
  onCursor,
}: {
  initialContent: string;
  filename: string;
  readOnly?: boolean;
  /** 内容变化回调（同步传入最新全文，供保存/大小显示） */
  onChange?: (text: string) => void;
  onCursor?: (line: number, col: number) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const onCursorRef = useRef(onCursor);
  onChangeRef.current = onChange;
  onCursorRef.current = onCursor;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let cancelled = false;
    let view: EditorView | null = null;
    void loadLangForFile(filename).then((lang) => {
      if (cancelled) return;
      const state = EditorState.create({
        doc: initialContent,
        extensions: [
          lineNumbers(),
          highlightActiveLine(),
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
          lang ?? [],
          oneDark,
          EditorView.lineWrapping,
          EditorState.readOnly.of(!!readOnly),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) onChangeRef.current?.(u.state.doc.toString());
            if (u.selectionSet && onCursorRef.current) {
              const pos = u.state.selection.main.head;
              const line = u.state.doc.lineAt(pos);
              onCursorRef.current(line.number, pos - line.from + 1);
            }
          }),
        ],
      });
      view = new EditorView({ state, parent: container });
      viewRef.current = view;
    });
    return () => {
      cancelled = true;
      view?.destroy();
      viewRef.current = null;
    };
    // 仅挂载/卸载时重建（重新加载由外部 key 变化强制重建）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div ref={containerRef} className="h-full w-full overflow-hidden text-[13px]" />;
}

/** 供外部读取当前内容（保存时） */
export function getEditorText(view: EditorView | null): string | null {
  return view ? view.state.doc.toString() : null;
}
