import { indentWithTab } from "@codemirror/commands";
import { cpp } from "@codemirror/lang-cpp";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { oneDark } from "@codemirror/theme-one-dark";
import { useEffect, useRef } from "react";

interface CodeEditorProps {
  documentId: string;
  value: string;
  readOnly: boolean;
  dark: boolean;
  onChange: (documentId: string, value: string) => void;
}

const lightTheme = EditorView.theme(
  {
    "&": {
      backgroundColor: "var(--acm-editor-background)",
      color: "var(--acm-editor-foreground)",
    },
    ".cm-content": {
      caretColor: "var(--acm-editor-foreground)",
      fontFamily: "Consolas, 'Cascadia Code', monospace",
      fontSize: "14px",
      padding: "16px 0",
    },
    ".cm-gutters": {
      backgroundColor: "var(--acm-editor-background)",
      borderRight: "1px solid var(--acm-editor-border)",
      color: "var(--acm-editor-muted)",
      paddingRight: "8px",
    },
    ".cm-activeLine": {
      backgroundColor: "var(--acm-editor-active-line)",
    },
    ".cm-activeLineGutter": {
      backgroundColor: "var(--acm-editor-active-line)",
      color: "var(--acm-editor-foreground)",
    },
    ".cm-selectionBackground, ::selection": {
      backgroundColor: "var(--acm-editor-selection) !important",
    },
    ".cm-focused": {
      outline: "none",
    },
  },
  { dark: false },
);

function editorTheme(dark: boolean): Extension {
  return dark ? oneDark : lightTheme;
}

export default function CodeEditor({
  documentId,
  value,
  readOnly,
  dark,
  onChange,
}: CodeEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const readOnlyRef = useRef(new Compartment());
  const contentAttributesRef = useRef(new Compartment());
  const themeRef = useRef(new Compartment());
  const onChangeRef = useRef(onChange);
  const documentIdRef = useRef(documentId);

  useEffect(() => {
    onChangeRef.current = onChange;
    documentIdRef.current = documentId;
  }, [documentId, onChange]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const state = EditorState.create({
      doc: value,
      extensions: [
        basicSetup,
        cpp(),
        EditorView.lineWrapping,
        readOnlyRef.current.of([
          EditorState.readOnly.of(readOnly),
          EditorView.editable.of(!readOnly),
        ]),
        contentAttributesRef.current.of(
          EditorView.contentAttributes.of({
            "aria-label": "C++ 源码编辑器",
            "aria-readonly": String(readOnly),
          }),
        ),
        themeRef.current.of(editorTheme(dark)),
        keymap.of([indentWithTab]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged)
            onChangeRef.current(
              documentIdRef.current,
              update.state.doc.toString(),
            );
        }),
      ],
    });
    const view = new EditorView({ state, parent: host });
    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || view.state.doc.toString() === value) return;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: value },
    });
  }, [value]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: [
        readOnlyRef.current.reconfigure([
          EditorState.readOnly.of(readOnly),
          EditorView.editable.of(!readOnly),
        ]),
        contentAttributesRef.current.reconfigure(
          EditorView.contentAttributes.of({
            "aria-label": "C++ 源码编辑器",
            "aria-readonly": String(readOnly),
          }),
        ),
      ],
    });
  }, [readOnly]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: themeRef.current.reconfigure(editorTheme(dark)),
    });
  }, [dark]);

  return <div ref={hostRef} className="acm-code-editor" />;
}
