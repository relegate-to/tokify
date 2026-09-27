import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { RichTextEditor } from './src/components/RichTextEditor';
import { SketchpadView } from './src/components/SketchpadView';
import './src/style.css';
import '@fontsource-variable/instrument-sans';

function Check() {
    const [value, setValue] = useState('');
    const [updates, setUpdates] = useState(0);
    const [mode, setMode] = useState('notes');
    const [started, setStarted] = useState('');
    return <main style={{ maxWidth: 760, margin: '40px auto', padding: 24 }}>
        <nav style={{ display: 'flex', gap: 24, marginBottom: 32 }}>
            <button onClick={() => setMode('notes')}>Notes page</button>
            <button onClick={() => setMode('compact')}>Compact editor</button>
            <button onClick={() => setMode('project')}>Project preview</button>
            <button onClick={() => { setValue('<h2>A busy week</h2>' + '<p>Thoughts, plans, and a useful note to come back to. Keep the writing simple.</p>'.repeat(1000)); setMode('long'); }}>Long note</button>
            <button onClick={() => document.documentElement.classList.toggle('dark')}>Toggle theme</button>
        </nav>
        {started && <p role="status">Running activity: {started}</p>}
        {mode === 'notes' ? <SketchpadView projects={['Tokify', 'Imaged Reality']} onStartTodo={async (todo) => { setStarted(`${todo.description} / ${todo.project || 'No project'} / ${todo.notes}`); }} /> : <>
            <div style={{ width: mode === 'compact' ? 334 : '100%' }}>
                <RichTextEditor value={value} onValueChange={next => { setValue(next); setUpdates(count => count + 1); }}
                    projects={['Tokify', 'Imaged Reality']} onStartTodo={async (todo) => { setStarted(`${todo.description} / ${todo.project || 'No project'} / ${todo.notes}`); }}
                    showToolbar={mode !== 'project'} className={mode === 'project' ? 'rich-editor-document' : undefined}
                    ariaLabel="Test note" contentClassName={mode === 'project' ? 'min-h-72 py-7 text-[17px] leading-8' : 'min-h-24 px-3 py-2 text-sm leading-6'} />
            </div>
            {mode !== 'project' && <><p>Save calls: {updates}</p>
            <output style={{ display: 'block', overflowWrap: 'anywhere', maxHeight: 180, overflow: 'auto' }}>{value.slice(0, 1600)}</output></>}
        </>}
    </main>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><Check /></React.StrictMode>);
