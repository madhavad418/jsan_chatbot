import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  ArrowUp, Check, ChevronDown, Code2, Copy, Gauge, KeyRound, LogOut,
  Menu, MessageSquarePlus, Moon, Paperclip, RotateCcw, Search, Sparkles,
  Sun, Terminal, Trash2, Wrench, X, Zap, BrainCircuit, Bug, GitPullRequest,
  Blocks, BookOpenText, ShieldCheck, ExternalLink, CheckCircle2,
  Presentation, FileUp, Download, LoaderCircle, TriangleAlert, Palette
} from 'lucide-react';
import './styles.css';

/** `previewMode` is set by the server while it runs without a database: no
 *  sign-in, one shared session, nothing saved past a restart. */
type User = { id:string; name:string; email:string; previewMode?:boolean };
type Conv = { id:string; title:string; mode:string; updated_at:string };
type Msg = { role:'user'|'assistant'; content:string };
type Mode = 'auto'|'code'|'think'|'fast';
type Usage = { spend:number; maxBudget:number|null; budgetDuration:string|null; models:string[]; rpmLimit:number|null; tpmLimit:number|null };

type Attachment = { name:string; size:number; content:string };

const MODES:{id:Mode; label:string; hint:string; icon:any}[] = [
  {id:'auto', label:'Auto', hint:'Best fit for the task', icon:Sparkles},
  {id:'code', label:'Code', hint:'Build, debug and review', icon:Code2},
  {id:'think', label:'Think', hint:'Architecture and deeper reasoning', icon:BrainCircuit},
  {id:'fast', label:'Fast', hint:'Quick answers and small tasks', icon:Zap}
];

/** The shortcut is Ctrl on Windows/Linux — showing ⌘ there is just wrong. */
const SHORTCUT_LABEL = /Mac|iPhone|iPad/.test(
  (typeof navigator !== 'undefined' && (navigator.platform || navigator.userAgent)) || ''
) ? '⌘K' : 'Ctrl K';

const QUICK = [
  {icon:Bug,title:'Fix a bug',desc:'Find the cause and verify the fix',text:'Help me debug this issue. Identify the likely root cause, propose the safest fix, and include concrete verification steps.'},
  {icon:GitPullRequest,title:'Review code',desc:'Check correctness, security and quality',text:'Review this code for correctness, security, performance and maintainability. Prioritize material issues and suggest focused improvements.'},
  {icon:Blocks,title:'Build a feature',desc:'Design it and implement it cleanly',text:'Help me design and implement this feature with production-ready code, clear assumptions, edge cases and verification steps.'},
  {icon:BookOpenText,title:'Explain code',desc:'Understand unfamiliar code quickly',text:'Explain what this code does in simple terms, then call out important dependencies, risks and opportunities to improve it.'}
];

/* Attachments are inlined into the prompt as text, so a file only works if it
   genuinely IS text. Reading a PDF, image or Office file with `File.text()`
   succeeds but yields mojibake: the model receives thousands of tokens of noise
   instead of the document, and is billed for them. Those types are refused with
   a reason rather than accepted and quietly mangled. */
const MAX_ATTACHMENTS = 4;
const MAX_ATTACHMENT_KB = 732;   // 750_000 bytes
const TEXT_EXTENSIONS = new Set([
  'txt','md','markdown','rst','adoc','json','jsonl','yaml','yml','toml','xml','csv','tsv','log','ini','cfg','conf','properties','env',
  'sql','graphql','gql','proto','sh','bash','zsh','fish','ps1','bat','cmd','make','mk','cmake','gradle','tf','tfvars',
  'js','jsx','mjs','cjs','ts','tsx','py','rb','go','rs','java','kt','kts','swift','m','mm','c','h','cpp','cc','hpp','cs','php','pl','pm','lua','r','scala','clj','ex','exs','erl','dart','hs','vb','f90',
  'html','htm','css','scss','sass','less','vue','svelte','astro','svg','diff','patch','snap','lock','gitignore','dockerignore','editorconfig'
]);
const DOCUMENT_EXTENSIONS = new Set([
  'pdf','doc','docx','ppt','pptx','xls','xlsx','odt','odp','ods','rtf','pages','key','numbers','epub','mobi'
]);
const NAMED_TEXT_FILES = new Set(['dockerfile','makefile','license','licence','readme','changelog','gemfile','procfile','rakefile','.gitignore','.env','.editorconfig']);

function attachmentKind(file:File):'text'|'document'|'image'|'media'|'unknown' {
  const name = file.name.toLowerCase();
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : name;
  if (file.type.startsWith('image/')) return 'image';
  if (file.type.startsWith('audio/') || file.type.startsWith('video/')) return 'media';
  if (DOCUMENT_EXTENSIONS.has(ext)) return 'document';
  if (TEXT_EXTENSIONS.has(ext) || NAMED_TEXT_FILES.has(name) || file.type.startsWith('text/')) return 'text';
  if (file.type === 'application/json' || file.type === 'application/xml') return 'text';
  return 'unknown';
}

/** A text extension is not a promise. U+FFFD is what the decoder emits for bytes
 *  it could not represent, so a run of them means this was never really text. */
function looksBinary(content:string) {
  const sample = content.slice(0, 4000);
  if (!sample) return false;
  // eslint-disable-next-line no-control-regex
  const undecodable = (sample.match(/[\uFFFD\u0000-\u0008\u000E-\u001F]/g) || []).length;
  return undecodable > sample.length * 0.01 + 5;
}

const ATTACH_ACCEPT = 'text/*,application/json,application/xml,' +
  [...TEXT_EXTENSIONS].map(e => '.' + e).join(',');

async function api(path:string, options:RequestInit = {}) {
  const res = await fetch(path, {
    credentials:'include',
    ...options,
    headers:{ ...(options.body ? {'Content-Type':'application/json'} : {}), ...(options.headers || {}) }
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Carry the status and reason through: some non-OK replies are expected
    // states to explain, not failures to show in red.
    const error:any = new Error(data.error || 'Request failed');
    error.status = res.status;
    error.reason = data.reason;
    throw error;
  }
  return data;
}

function CopyButton({value,small=false}:{value:string;small?:boolean}) {
  const [done,setDone] = useState(false);
  return <button className={`icon-button ${small?'small':''}`} title="Copy" onClick={async()=>{
    await navigator.clipboard.writeText(value); setDone(true); setTimeout(()=>setDone(false),1200);
  }}>{done ? <Check size={14}/> : <Copy size={14}/>}</button>;
}

/** JSAN wordmark + product lockup. `invert` renders it white for blue panels. */
function Brand({compact=false, invert=false, size='md'}:{compact?:boolean; invert?:boolean; size?:'md'|'lg'}) {
  return <div className={`brand${compact?' compact':''}${invert?' brand-invert':''}${size==='lg'?' brand-lg':''}`}>
    <img className="brand-logo" src="/jsan-logo.png" alt="JSAN" />
    {!compact && <>
      <span className="brand-divider" aria-hidden="true" />
      <span className="brand-product">Dev AI</span>
    </>}
  </div>;
}

function ThemeButton(){
  const [dark,setDark]=useState(()=>localStorage.getItem('jsan-theme')==='dark');
  useEffect(()=>{document.documentElement.dataset.theme=dark?'dark':'light';localStorage.setItem('jsan-theme',dark?'dark':'light')},[dark]);
  return <button className="icon-button" title={dark?'Use light theme':'Use dark theme'} onClick={()=>setDark(v=>!v)}>{dark?<Sun size={15}/>:<Moon size={15}/>}</button>
}

function Auth({onReady}:{onReady:(u:User)=>void}) {
  const [tab,setTab] = useState<'login'|'register'>('login');
  const [form,setForm] = useState({name:'',email:'',password:'',accessCode:''});
  const [status,setStatus] = useState<any>(null);
  const [error,setError] = useState('');
  const [busy,setBusy] = useState(false);
  useEffect(()=>{ api('/api/auth/registration-status').then(setStatus).catch(()=>{}); },[]);
  const submit = async(e:React.FormEvent)=>{
    e.preventDefault(); setBusy(true); setError('');
    try { const data = await api(`/api/auth/${tab}`,{method:'POST',body:JSON.stringify(form)}); onReady(data.user); }
    catch(e:any){ setError(e.message); } finally { setBusy(false); }
  };
  const canRegister = status?.registrationOpen !== false;
  return <div className="auth-screen">
    <div className="auth-glow glow-a"/><div className="auth-glow glow-b"/>
    <header className="auth-top"><Brand/><ThemeButton/></header>
    <main className="auth-main">
      <section className="auth-intro">
        <div className="auth-intro-brand"><Brand invert size="lg"/></div>
        <div className="auth-intro-body">
          <div className="product-chip"><Sparkles size={13}/> Built for engineering work</div>
          <h1>Move from question<br/>to working code faster.</h1>
          <p>A focused AI workspace for debugging, implementation, code review and architecture—available in the browser and your coding tools.</p>
          <div className="auth-proof">
            <div><CheckCircle2 size={16}/><span>One workspace</span></div>
            <div><CheckCircle2 size={16}/><span>One developer key</span></div>
            <div><CheckCircle2 size={16}/><span>Multiple AI providers</span></div>
          </div>
        </div>
        <p className="auth-intro-foot">JSAN Consulting — Global IT Partner</p>
      </section>
      <section className="auth-card">
        <div className="auth-card-head">
          <div><span className="eyebrow">JSAN Engineering</span><h2>{tab==='login' ? 'Welcome back' : 'Create your account'}</h2></div>
          {tab==='register'&&status&&<span className="seat-pill">{status.remaining} seats left</span>}
        </div>
        <p>{tab==='login' ? 'Continue where you left off.' : 'Use your work email and team access code.'}</p>
        <div className="auth-tabs">
          <button className={tab==='login'?'active':''} onClick={()=>{setTab('login');setError('')}}>Sign in</button>
          <button disabled={!canRegister} className={tab==='register'?'active':''} onClick={()=>{setTab('register');setError('')}}>Register</button>
        </div>
        <form onSubmit={submit}>
          {tab==='register' && <label>Full name<input autoComplete="name" value={form.name} onChange={e=>setForm({...form,name:e.target.value})} placeholder="Your name" required/></label>}
          <label>Work email<input autoComplete="email" type="email" value={form.email} onChange={e=>setForm({...form,email:e.target.value})} placeholder="name@jsanconsulting.com" required/></label>
          <label>Password<input autoComplete={tab==='login'?'current-password':'new-password'} type="password" value={form.password} onChange={e=>setForm({...form,password:e.target.value})} placeholder="At least 10 characters" required/></label>
          {tab==='register' && <label>Team access code<input value={form.accessCode} onChange={e=>setForm({...form,accessCode:e.target.value})} placeholder="Code shared by your team" required/></label>}
          {error && <div className="form-error">{error}</div>}
          <button className="primary-button full" disabled={busy}>{busy?'Please wait…':tab==='login'?'Sign in':'Create account'}</button>
        </form>
        <div className="auth-security"><ShieldCheck size={14}/><span>Provider credentials are never exposed to developer devices.</span></div>
      </section>
    </main>
  </div>;
}

function App() {
  const [user,setUser] = useState<User|null>(null);
  const [loading,setLoading] = useState(true);
  const [page,setPage] = useState<'chat'|'slides'|'tools'|'usage'>('chat');
  const [mobileNav,setMobileNav] = useState(false);
  // Bumping this tells an already-mounted Chat to clear itself. It lives here
  // rather than in Chat because the shortcut and the button must work from
  // Tools and Usage too, where Chat is not mounted to hear a window event.
  const [newChatToken,setNewChatToken] = useState(0);
  useEffect(()=>{ api('/api/me').then(setUser).catch(()=>{}).finally(()=>setLoading(false)); },[]);

  const startNewChat = useCallback(()=>{
    setPage('chat');
    setMobileNav(false);
    setNewChatToken(t=>t+1);
  },[]);

  useEffect(()=>{
    const onKey=(e:KeyboardEvent)=>{
      if((e.metaKey||e.ctrlKey) && e.key.toLowerCase()==='k'){ e.preventDefault(); startNewChat(); }
    };
    window.addEventListener('keydown',onKey);
    return ()=>window.removeEventListener('keydown',onKey);
  },[startNewChat]);
  if(loading) return <div className="boot"><Brand/></div>;
  // In preview mode /api/me returns a shared session, so `user` is always set
  // and this never renders. Sign-in comes back untouched with the database.
  if(!user) return <Auth onReady={setUser}/>;
  const preview = user.previewMode === true;
  return <div className="app-shell">
    <aside className={`sidebar ${mobileNav?'show':''}`}>
      <div className="sidebar-top"><Brand/><button className="mobile-close icon-button" onClick={()=>setMobileNav(false)}><X size={17}/></button></div>
      <button className="new-chat" onClick={startNewChat}><MessageSquarePlus size={16}/><span>New chat</span><kbd>{SHORTCUT_LABEL}</kbd></button>
      <nav>
        <button className={page==='chat'?'active':''} onClick={()=>{setPage('chat');setMobileNav(false)}}><Sparkles size={16}/><span>Chat</span></button>
        <button className={page==='slides'?'active':''} onClick={()=>{setPage('slides');setMobileNav(false)}}><Presentation size={16}/><span>Slides</span></button>
        <button className={page==='tools'?'active':''} onClick={()=>{setPage('tools');setMobileNav(false)}}><Terminal size={16}/><span>Tools</span></button>
        <button className={page==='usage'?'active':''} onClick={()=>{setPage('usage');setMobileNav(false)}}><Gauge size={16}/><span>Usage</span></button>
      </nav>
      <div className="sidebar-spacer"/>
      <div className="sidebar-foot">
        <div className="avatar">{user.name.split(/\s+/).slice(0,2).map(x=>x[0]).join('').toUpperCase()}</div>
        <div className="who"><strong>{user.name}</strong><span>{preview?'Not signed in':user.email}</span></div>
        <ThemeButton/>
        {/* Nothing to sign out of while preview mode is on. */}
        {!preview&&<button className="icon-button" title="Sign out" onClick={async()=>{await api('/api/auth/logout',{method:'POST'});setUser(null)}}><LogOut size={15}/></button>}
      </div>
    </aside>
    <main className={`main-area${preview?' has-banner':''}`}>
      {preview&&<div className="preview-banner" title="The portal is running without a database. Sign-in, saved history and personal developer keys return once Postgres is provisioned."><Wrench size={13}/><span><strong>Preview mode</strong> — no sign-in, and conversations are kept in memory only until the database is provisioned.</span></div>}
      <button className="mobile-menu icon-button" onClick={()=>setMobileNav(true)}><Menu size={18}/></button>
      {/* Chat stays mounted so switching to Tools/Usage and back keeps the
          open conversation, the draft and the scroll position. */}
      <Chat newChatToken={newChatToken} hidden={page!=='chat'}/>
      {page==='slides' && <SlidesPage/>}
      {page==='tools' && <Tools previewMode={preview}/>}
      {page==='usage' && <UsagePage previewMode={preview}/>}
    </main>
  </div>;
}

function Chat({newChatToken=0, hidden=false}:{newChatToken?:number; hidden?:boolean}) {
  const [convs,setConvs] = useState<Conv[]>([]);
  const [active,setActive] = useState<string|null>(null);
  const [messages,setMessages] = useState<Msg[]>([]);
  const [mode,setMode] = useState<Mode>('auto');
  const [modeOpen,setModeOpen] = useState(false);
  const [input,setInput] = useState('');
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState('');
  const [historyOpen,setHistoryOpen] = useState(false);
  const [search,setSearch] = useState('');
  const [attachments,setAttachments]=useState<Attachment[]>([]);
  const fileRef=useRef<HTMLInputElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const refresh = ()=>api('/api/conversations').then(setConvs).catch(()=>{});
  // Load the list on mount and again each time the user comes back to Chat,
  // so anything started in another tab or on another machine shows up.
  useEffect(()=>{
    if(!hidden) refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[hidden]);
  useEffect(()=>{ endRef.current?.scrollIntoView({behavior:'smooth'}); },[messages,busy]);
  // Clear the workspace whenever "New chat" is triggered, from any page.
  // Focusing the composer is what makes the click feel like it did something —
  // without it, pressing New chat on an already-empty chat looks like a no-op.
  // Skipped on the first run: the workspace is already empty at mount, and the
  // effect above has the list covered.
  const firstToken = useRef(true);
  useEffect(()=>{
    if(firstToken.current){ firstToken.current = false; return; }
    setActive(null); setMessages([]); setInput(''); setMode('auto'); setError(''); setAttachments([]);
    if(!hidden) composerRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[newChatToken]);
  const load = async(id:string)=>{ const d=await api(`/api/conversations/${id}`); setActive(id); setMessages(d.messages.map((m:any)=>({role:m.role,content:m.content}))); setMode((d.mode||'auto') as Mode); setHistoryOpen(false); };
  // Every rejection is reported. Silently dropping a file is worse than refusing
  // it: the developer believes the AI read something it never received.
  const pickFiles=async(files:FileList|null)=>{
    if(!files)return;
    const accepted:Attachment[]=[]; const rejected:string[]=[];
    let room=MAX_ATTACHMENTS-attachments.length;
    for(const f of Array.from(files)){
      if(room<=0){rejected.push(`${f.name} — limit is ${MAX_ATTACHMENTS} files per message`);continue}
      const kind=attachmentKind(f);
      if(kind==='image'){rejected.push(`${f.name} — images can't be read yet`);continue}
      if(kind==='media'){rejected.push(`${f.name} — audio and video can't be read`);continue}
      if(kind==='document'){
        rejected.push(/\.pdf$/i.test(f.name)
          ? `${f.name} — PDFs can't be read in chat; open Slides to turn a PDF into a PowerPoint deck`
          : `${f.name} — Office files can't be read yet; export it to .txt or .md first`);
        continue;
      }
      if(kind==='unknown'){rejected.push(`${f.name} — only text and code files can be attached`);continue}
      if(f.size>MAX_ATTACHMENT_KB*1024){rejected.push(`${f.name} — ${Math.round(f.size/1024)} KB is over the ${MAX_ATTACHMENT_KB} KB limit`);continue}
      let content:string;
      try{content=await f.text()}catch{rejected.push(`${f.name} — could not be read`);continue}
      if(looksBinary(content)){rejected.push(`${f.name} — contents aren't readable text`);continue}
      accepted.push({name:f.name,size:f.size,content});room--;
    }
    if(accepted.length)setAttachments(a=>[...a,...accepted].slice(0,MAX_ATTACHMENTS));
    setError(rejected.length?`Not attached — ${rejected.join('. ')}.`:'');
    if(fileRef.current)fileRef.current.value=''
  };
  const send = async(text=input)=>{
    const base=text.trim(); if((!base&&!attachments.length)||busy)return;
    const attached=attachments.map(a=>`\n\n--- Attached file: ${a.name} ---\n${a.content}\n--- End ${a.name} ---`).join('');
    const message=(base||'Please review the attached file(s).')+attached;
    const display=base+(attachments.length?`\n\n${attachments.map(a=>`📎 ${a.name}`).join('\n')}`:'');
    setInput(''); setAttachments([]); setError(''); setBusy(true); setMessages(m=>[...m,{role:'user',content:display}]);
    try{ const d=await api('/api/chat',{method:'POST',body:JSON.stringify({message,mode,conversationId:active})}); setActive(d.conversationId); setMessages(m=>[...m,{role:'assistant',content:d.answer}]); refresh(); }
    catch(e:any){setMessages(m=>m.slice(0,-1));setInput(base);setError(e.message)} finally {setBusy(false)}
  };
  const del = async(e:React.MouseEvent,id:string)=>{e.stopPropagation();await api(`/api/conversations/${id}`,{method:'DELETE'});if(active===id){setActive(null);setMessages([])}refresh()};
  const currentMode=MODES.find(m=>m.id===mode)!; const ModeIcon=currentMode.icon;
  const filtered=convs.filter(c=>c.title.toLowerCase().includes(search.toLowerCase()));
  return <div className={`chat-layout${hidden?' is-hidden':''}`}>
    <aside className={`history ${historyOpen?'show':''}`}>
      <div className="history-head"><span>Conversations</span><button className="mobile-close icon-button" onClick={()=>setHistoryOpen(false)}><X size={15}/></button></div>
      <div className="history-search"><Search size={13}/><input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search"/></div>
      <div className="history-list">{filtered.length===0?<div className="history-empty">{convs.length?'No matches yet.':'Your recent work will appear here.'}</div>:filtered.map(c=><button key={c.id} className={`history-item ${active===c.id?'active':''}`} onClick={()=>load(c.id)}><span>{c.title}</span><Trash2 onClick={e=>del(e,c.id)} size={13}/></button>)}</div>
    </aside>
    <section className="workspace">
      <header className="workspace-header">
        <div className="workspace-left"><button className="history-toggle icon-button" onClick={()=>setHistoryOpen(true)}><Menu size={15}/></button><div className="status-dot"/><strong>{active?'Conversation':'New chat'}</strong></div>
        <div className="mode-select">
          <button onClick={()=>setModeOpen(v=>!v)}><ModeIcon size={14}/>{currentMode.label}<ChevronDown size={14}/></button>
          {modeOpen&&<div className="mode-menu">{MODES.map(m=>{const I=m.icon;return <button key={m.id} className={m.id===mode?'selected':''} onClick={()=>{setMode(m.id);setModeOpen(false)}}><I size={15}/><div><strong>{m.label}</strong><span>{m.hint}</span></div>{m.id===mode&&<Check size={14}/>}</button>})}</div>}
        </div>
      </header>
      <div className="thread">
        {messages.length===0 ? <div className="empty-state">
          <div className="hero-kicker"><span className="pulse-dot"/> Ready to work</div>
          <h1>What are you building?</h1>
          <p>Bring a bug, a feature, a codebase question or an architecture decision.</p>
          <div className="quick-grid">{QUICK.map(q=>{const I=q.icon;return <button key={q.title} onClick={()=>{setInput(q.text);setTimeout(()=>document.querySelector<HTMLTextAreaElement>('.composer textarea')?.focus(),0)}}><div className="quick-icon"><I size={16}/></div><div><strong>{q.title}</strong><span>{q.desc}</span></div><ArrowUp size={14}/></button>})}</div>
          <div className="starter-note"><ShieldCheck size={14}/><span>Use approved work content only. Review generated code before merging.</span></div>
        </div> : messages.map((m,i)=>m.role==='user' ? <div className="user-message" key={i}><div>{m.content}</div></div> : <div className="assistant-message" key={i}><div className="assistant-icon"><Sparkles size={14}/></div><div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown><button className="copy-answer" onClick={()=>navigator.clipboard.writeText(m.content)}><Copy size={12}/>Copy response</button></div></div>)}
        {busy&&<div className="assistant-message"><div className="assistant-icon"><Sparkles size={14}/></div><div className="thinking"><span>Working</span><i/><i/><i/></div></div>}
        {error&&<div className="chat-error">{error}</div>}
        <div ref={endRef}/>
      </div>
      <footer className="composer-area">
        <div className="composer">
          {attachments.length>0&&<div className="attachments">{attachments.map((a,i)=><span key={a.name+i}><Code2 size={12}/>{a.name}<button onClick={()=>setAttachments(x=>x.filter((_,j)=>j!==i))}><X size={11}/></button></span>)}</div>}
          <textarea ref={composerRef} value={input} onChange={e=>setInput(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send()}}} placeholder="Ask about code, bugs, architecture or implementation…" rows={1}/>
          <div className="composer-foot"><div className="composer-actions"><input ref={fileRef} type="file" multiple hidden accept={ATTACH_ACCEPT} onChange={e=>pickFiles(e.target.files)}/><button className="composer-tool" title={`Attach text or code files — up to ${MAX_ATTACHMENTS} files, ${MAX_ATTACHMENT_KB} KB each. PDF, Office and image files are not readable yet.`} onClick={()=>fileRef.current?.click()}><Paperclip size={14}/><span>Attach</span></button><span className="mode-label"><ModeIcon size={12}/>{currentMode.label}</span></div><div className="send-side"><span>Enter to send</span><button className="send-button" disabled={(!input.trim()&&!attachments.length)||busy} onClick={()=>send()}><ArrowUp size={16}/></button></div></div>
        </div>
      </footer>
    </section>
  </div>;
}

function Tools({previewMode=false}:{previewMode?:boolean}) {
  const [key,setKey] = useState(''); const [cfg,setCfg] = useState<any>(null); const [show,setShow] = useState(false); const [busy,setBusy] = useState(false); const [error,setError] = useState('');
  // Signed in, but the gateway has not issued this developer a personal key yet.
  const [keyPending,setKeyPending] = useState(false);
  // The endpoint snippets are the same for everyone, so they still load in
  // preview mode. Only the personal key needs an account behind it.
  useEffect(()=>{api('/api/tools/config').then(setCfg).catch(e=>setError(e.message))},[]);
  useEffect(()=>{
    if(previewMode)return;
    api('/api/me/api-key')
      .then(k=>{setKey(k.apiKey);setKeyPending(false)})
      .catch((e:any)=>{ if(e.reason==='personal-key-pending') setKeyPending(true); else setError(e.message) });
  },[previewMode]);
  const rotate=async()=>{if(!confirm('Rotate your developer key? Tools using the old key will stop working.'))return;setBusy(true);setError('');try{const d=await api('/api/me/api-key/rotate',{method:'POST'});setKey(d.apiKey)}catch(e:any){setError(e.message)}finally{setBusy(false)}};
  return <div className="page">
    <header className="page-header"><div><span className="eyebrow">Developer tools</span><h1>Take the same AI into your editor.</h1><p>Use one JSAN endpoint and your personal key across supported coding tools.</p></div><div className="header-badge"><span/><strong>Gateway ready</strong></div></header>
    {error&&<div className="page-error">{error}</div>}
    <div className="content-grid">
      {previewMode || keyPending
        ? <section className="card span-2"><div className="card-head simple"><div><div className="card-icon"><KeyRound size={17}/></div><div><h2>Your developer key</h2><p>{previewMode
            ? 'Keys are issued per account, so this waits on the database. The endpoint below is already live — it just needs a key to authenticate with.'
            : 'Your account exists, but the AI gateway has not issued your personal key yet. Chat and Slides work in the meantime — they call the gateway from the server.'}</p></div></div></div>
          <div className="preview-notice"><Wrench size={13}/><span>{previewMode
            ? 'Available as soon as Postgres is provisioned and sign-in is switched back on.'
            : 'The gateway needs its own database before it can create per-developer keys. Your key appears here once it can.'}</span></div></section>
        : <section className="card span-2 key-card"><div className="card-head"><div><div className="card-icon"><KeyRound size={17}/></div><div><h2>Your developer key</h2><p>Use it in your own tools. Keep it private.</p></div></div><button className="secondary-button" onClick={rotate} disabled={busy}><RotateCcw size={14}/>{busy?'Rotating…':'Rotate key'}</button></div><div className="key-box"><code>{show?key:key?`${key.slice(0,8)}${'•'.repeat(30)}${key.slice(-5)}`:'Loading…'}</code><button className="text-button" onClick={()=>setShow(v=>!v)}>{show?'Hide':'Show'}</button><CopyButton value={key}/></div></section>}
      <ToolCard icon={<Code2 size={17}/>} title="Codex CLI" text="Use Code mode through the JSAN gateway." value={cfg?.codex||''} note="Set JSAN_AI_KEY to your developer key."/>
      <ToolCard icon={<Sparkles size={17}/>} title="Claude Code" text="Route Claude Code through the same gateway." value={cfg?.claude||''} note="Use your developer key as the Anthropic auth token."/>
      <ToolCard icon={<Terminal size={17}/>} title="OpenAI-compatible tools" text="For IDEs, SDKs and local scripts." value={cfg?.env||''} note={`Base URL: ${cfg?.baseUrl||'—'}`}/>
      <ToolCard icon={<Wrench size={17}/>} title="Connection check" text="Confirm your endpoint and key in one command." value={cfg?.curl||''} note="A model list means the connection is working."/>
      <section className="card span-2 tool-help"><div><h2>Recommended setup</h2><p>Use the browser for discussion and quick reviews. Use Codex or Claude Code when you want AI working directly with a repository.</p></div><a href="https://ai.jsanconsulting.com/v1" target="_blank" rel="noreferrer">API endpoint <ExternalLink size={13}/></a></section>
    </div>
  </div>;
}

function ToolCard({icon,title,text,value,note}:{icon:any;title:string;text:string;value:string;note:string}){return <section className="card"><div className="card-head simple"><div><div className="card-icon">{icon}</div><div><h2>{title}</h2><p>{text}</p></div></div></div><Snippet value={value}/><p className="card-note">{note}</p></section>}
function Snippet({value}:{value:string}) { return <div className="snippet"><pre>{value||'Loading…'}</pre><CopyButton value={value}/></div> }

type DeckTemplate = { id:string; label:string; description:string; swatch:string[] };
type DeckResult = {
  file:{ filename:string; base64:string; bytes:number; contentType:string };
  deck:{ title:string; subtitle:string; slideCount:number; slideTitles:string[]; organisedBy:string; template:string };
  source:{ pages:number; pageCount:number; headings:number; tablesCarried:number; tablesFound:number; imagesCarried:number; imagesFound:number };
  warnings:string[];
};

const CONVERT_STEPS = [
  {key:'extracting', label:'Reading the PDF'},
  {key:'planning',   label:'Organising slides'},
  {key:'building',   label:'Building the file'},
  {key:'done',       label:'Ready to download'}
];

/** Decode without spreading: a multi-megabyte deck would blow the call stack. */
function base64ToBytes(base64:string) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function SlidesPage() {
  const [templates,setTemplates] = useState<DeckTemplate[]>([]);
  const [template,setTemplate] = useState('');
  const [limits,setLimits] = useState({maxPdfBytes:8*1024*1024, maxPages:60});
  const [file,setFile] = useState<File|null>(null);
  const [useAi,setUseAi] = useState(true);
  const [stage,setStage] = useState('idle');
  const [note,setNote] = useState('');
  const [error,setError] = useState('');
  const [result,setResult] = useState<DeckResult|null>(null);
  const [dragging,setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(()=>{
    api('/api/documents/templates')
      .then(d=>{ setTemplates(d.templates); setTemplate(t=>t||d.defaultTemplate); setLimits({maxPdfBytes:d.maxPdfBytes, maxPages:d.maxPages}); })
      .catch(e=>setError(e.message));
  },[]);

  const busy = stage!=='idle' && stage!=='done' && stage!=='failed';
  const maxMb = Math.round(limits.maxPdfBytes/1024/1024);

  // Everything is checked before upload too, so an obvious mistake costs no round trip.
  const choose = (picked?:File|null) => {
    setError(''); setResult(null); setStage('idle'); setNote('');
    if (!picked) return;
    if (!(picked.type === 'application/pdf' || /\.pdf$/i.test(picked.name))) {
      setError(`${picked.name} is not a PDF. Choose a file that ends in .pdf.`); return;
    }
    if (!picked.size) { setError(`${picked.name} is empty.`); return; }
    if (picked.size > limits.maxPdfBytes) {
      setError(`${picked.name} is ${(picked.size/1024/1024).toFixed(1)} MB. The limit is ${maxMb} MB.`); return;
    }
    setFile(picked);
  };

  const convert = async () => {
    if (!file || busy) return;
    setError(''); setResult(null); setStage('extracting'); setNote('Reading the PDF');
    try {
      const dataUrl = await new Promise<string>((resolve,reject)=>{
        const reader = new FileReader();
        reader.onload = ()=>resolve(String(reader.result));
        reader.onerror = ()=>reject(new Error('That file could not be read from disk.'));
        reader.readAsDataURL(file);
      });

      const res = await fetch('/api/documents/pdf-to-pptx', {
        method:'POST',
        credentials:'include',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({
          filename:file.name,
          pdfBase64: dataUrl.slice(dataUrl.indexOf(',')+1),
          theme:template,
          useAi
        })
      });
      if (!res.ok || !res.body) {
        const detail = await res.json().catch(()=>({}));
        throw new Error(detail.error || `The conversion failed (${res.status}).`);
      }

      // Progress is streamed as newline-delimited JSON while the work happens,
      // so the steps below reflect the server rather than a timer.
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let finished:DeckResult|null = null;
      for(;;){
        const {value,done} = await reader.read();
        if (done) break;
        buffer += decoder.decode(value,{stream:true});
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line);
          if (event.stage === 'failed') throw new Error(event.error || 'The conversion failed.');
          if (event.message) setNote(event.message);
          if (event.stage === 'done') { finished = event as DeckResult; setStage('done'); }
          else setStage(event.stage === 'extracted' ? 'planning' : event.stage);
        }
      }
      if (!finished) throw new Error('The conversion ended before a file was produced.');
      setResult(finished);
      setNote('');
    } catch(e:any) {
      setStage('failed'); setNote(''); setError(e.message);
    }
  };

  const download = () => {
    if (!result) return;
    const blob = new Blob([base64ToBytes(result.file.base64)], {type:result.file.contentType});
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url; link.download = result.file.filename;
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(()=>URL.revokeObjectURL(url), 1000);
  };

  const stepIndex = CONVERT_STEPS.findIndex(s=>s.key===stage);
  const allDone = stage==='done';

  return <div className="page">
    <header className="page-header">
      <div>
        <span className="eyebrow">Documents</span>
        <h1>Turn a PDF into editable slides.</h1>
        <p>Headings, bullets, tables and figures come across as real PowerPoint content you can edit.</p>
      </div>
      <div className="header-badge"><span/><strong>PPTX</strong></div>
    </header>

    {error && <div className="page-error">{error}</div>}

    <div className="content-grid">
      <section className="card span-2">
        <div className="card-head simple"><div>
          <div className="card-icon"><FileUp size={17}/></div>
          <div><h2>1 — Choose a PDF</h2><p>Up to {maxMb} MB and {limits.maxPages} pages. The text has to be selectable — a scan needs OCR first.</p></div>
        </div></div>
        <input ref={inputRef} type="file" accept="application/pdf,.pdf" hidden onChange={e=>choose(e.target.files?.[0])}/>
        {!file
          ? <button
              className={`dropzone${dragging?' is-dragging':''}`}
              onClick={()=>inputRef.current?.click()}
              onDragOver={e=>{e.preventDefault(); setDragging(true)}}
              onDragLeave={()=>setDragging(false)}
              onDrop={e=>{e.preventDefault(); setDragging(false); choose(e.dataTransfer.files?.[0])}}>
              <FileUp size={20}/>
              <strong>Drop a PDF here, or click to choose</strong>
              <span>Processed on the server and not stored afterwards.</span>
            </button>
          : <div className="chosen-file">
              <span className="chosen-icon"><Presentation size={15}/></span>
              <span className="chosen-meta"><strong>{file.name}</strong><span>{(file.size/1024).toFixed(0)} KB</span></span>
              <button className="icon-button" title="Remove this file" disabled={busy}
                onClick={()=>{setFile(null); setResult(null); setStage('idle'); setError(''); setNote('')}}><X size={15}/></button>
            </div>}
      </section>

      <section className="card">
        <div className="card-head simple"><div>
          <div className="card-icon"><Palette size={17}/></div>
          <div><h2>2 — Template</h2><p>Applied to every generated slide.</p></div>
        </div></div>
        <div className="template-grid">
          {templates.length===0
            ? <span className="convert-hint">Loading templates…</span>
            : templates.map(t=>(
                <button key={t.id} disabled={busy}
                  className={`template-option${template===t.id?' selected':''}`}
                  onClick={()=>setTemplate(t.id)}>
                  <span className="swatch">{t.swatch.map((c,i)=><i key={i} style={{background:c}}/>)}</span>
                  <span className="template-meta"><strong>{t.label}</strong><span>{t.description}</span></span>
                  {template===t.id && <Check size={13}/>}
                </button>
              ))}
        </div>
      </section>

      <section className="card">
        <div className="card-head simple"><div>
          <div className="card-icon"><Sparkles size={17}/></div>
          <div><h2>3 — Structure</h2><p>How the deck gets organised.</p></div>
        </div></div>
        <label className="switch-row">
          <input type="checkbox" checked={useAi} disabled={busy} onChange={e=>setUseAi(e.target.checked)}/>
          <span className="switch" aria-hidden="true"/>
          <span className="switch-text">
            <strong>Use AI to organise the deck</strong>
            <span>It groups and titles the slides. Tables and figures are copied from the PDF either way, never rewritten, so no figure can be invented.</span>
          </span>
        </label>
        {!useAi && <p className="convert-hint">Slides will follow the PDF's own heading structure.</p>}
      </section>

      <section className="card span-2">
        <div className="convert-row">
          <button className="primary-button" disabled={!file||busy} onClick={convert}>
            {busy ? <><LoaderCircle size={14} className="spin"/>Converting…</> : <><Presentation size={14}/>Convert to PowerPoint</>}
          </button>
          {!file && stage==='idle' && <span className="convert-hint">Choose a PDF to begin.</span>}
          {note && <span className="convert-hint">{note}…</span>}
        </div>
        {(busy || allDone) && <ol className="stepper">
          {CONVERT_STEPS.map((step,i)=>{
            const done = allDone || stepIndex>i;
            return <li key={step.key} className={done?'is-done':stepIndex===i?'is-active':''}>
              <span className="step-dot">{done ? <Check size={11}/> : stepIndex===i ? <LoaderCircle size={11} className="spin"/> : i+1}</span>
              <span>{step.label}</span>
            </li>;
          })}
        </ol>}
      </section>

      {result && <section className="card span-2 deck-result">
        <div className="card-head">
          <div>
            <div className="card-icon"><Presentation size={17}/></div>
            <div>
              <h2>{result.deck.title}</h2>
              <p>{result.deck.slideCount} slides · {(result.file.bytes/1024).toFixed(0)} KB · organised by {result.deck.organisedBy==='ai'?'AI':'document structure'}</p>
            </div>
          </div>
          <button className="primary-button" onClick={download}><Download size={14}/>Download PPTX</button>
        </div>
        <div className="deck-stats">
          <div><strong>{result.source.pages}</strong><span>pages read{result.source.pageCount>result.source.pages?` of ${result.source.pageCount}`:''}</span></div>
          <div><strong>{result.source.headings}</strong><span>headings found</span></div>
          <div><strong>{result.source.tablesCarried}/{result.source.tablesFound}</strong><span>tables carried</span></div>
          <div><strong>{result.source.imagesCarried}/{result.source.imagesFound}</strong><span>figures carried</span></div>
        </div>
        {result.deck.slideTitles.length>0 && <div className="slide-list">
          {result.deck.slideTitles.map((title,i)=><span key={i}><b>{i+2}</b>{title}</span>)}
        </div>}
        {result.warnings.length>0 && <div className="deck-warnings">
          <TriangleAlert size={13}/>
          <div>{result.warnings.map((w,i)=><p key={i}>{w}</p>)}</div>
        </div>}
      </section>}
    </div>
  </div>;
}

function UsagePage({previewMode=false}:{previewMode?:boolean}) {
  const [data,setData] = useState<Usage|null>(null); const [error,setError] = useState('');
  const [keyPending,setKeyPending] = useState(false);
  // Spend is tracked per developer key, so a shared anonymous session — or an
  // account whose key has not been issued — has no usage of its own to show.
  useEffect(()=>{
    if(previewMode)return;
    api('/api/usage/me').then(setData)
      .catch((e:any)=>{ if(e.reason==='personal-key-pending') setKeyPending(true); else setError(e.message) });
  },[previewMode]);
  const pct = useMemo(()=>data?.maxBudget ? Math.min(100,(data.spend/data.maxBudget)*100) : 0,[data]);
  return <div className="page">
    <header className="page-header"><div><span className="eyebrow">Usage</span><h1>Simple visibility, no guesswork.</h1><p>See the access attached to your developer key without worrying about provider-level details.</p></div></header>
    {error&&<div className="page-error">{error}</div>}
    {previewMode || keyPending
      ?<div className="content-grid"><section className="card span-2"><div className="card-head simple"><div><div className="card-icon"><Gauge size={17}/></div><div><h2>Usage tracking is per developer</h2><p>{previewMode
        ? 'Each account gets its own key, and spend is measured against it. Preview mode shares one anonymous session, so there is nothing individual to report yet.'
        : 'Spend is measured against your personal gateway key, which has not been issued yet, so there is nothing individual to report.'}</p></div></div></div>
        <div className="preview-notice"><Wrench size={13}/><span>{previewMode
          ? 'Provision Postgres and turn sign-in back on to see per-developer spend and budgets.'
          : 'Once the gateway has its own database and issues your key, spend and budgets appear here.'}</span></div></section></div>
     :!data?<div className="skeleton"/>:<div className="content-grid">
      <section className="metric-card"><span>Current spend</span><strong>${data.spend.toFixed(2)}</strong><small>{data.budgetDuration?'Current budget period':'Tracked by the gateway'}</small></section>
      <section className="metric-card"><span>Personal budget</span><strong>{data.maxBudget==null?'Flexible':`$${data.maxBudget.toFixed(2)}`}</strong><small>{data.maxBudget==null?'No personal cap configured':`${Math.max(0,100-pct).toFixed(0)}% remaining`}</small></section>
      <section className="metric-card"><span>Work modes</span><strong>{data.models.length}</strong><small>Auto · Code · Think · Fast</small></section>
      <section className="metric-card"><span>Access</span><strong>{data.rpmLimit||'Managed'}</strong><small>{data.rpmLimit?'Requests per minute':'Handled centrally'}</small></section>
      {data.maxBudget!=null&&<section className="card span-2"><div className="budget-line"><div><h2>Budget use</h2><p>${data.spend.toFixed(2)} of ${data.maxBudget.toFixed(2)}</p></div><strong>{pct.toFixed(0)}%</strong></div><div className="progress"><span style={{width:`${pct}%`}}/></div></section>}
      <section className="card span-2 mode-guide"><div><span className="mode-symbol auto"><Sparkles size={16}/></span><strong>Auto</strong><p>Default for everyday work.</p></div><div><span className="mode-symbol code"><Code2 size={16}/></span><strong>Code</strong><p>Implementation and debugging.</p></div><div><span className="mode-symbol think"><BrainCircuit size={16}/></span><strong>Think</strong><p>Architecture and complex reasoning.</p></div><div><span className="mode-symbol fast"><Zap size={16}/></span><strong>Fast</strong><p>Quick questions and small tasks.</p></div></section>
    </div>}
  </div>;
}

createRoot(document.getElementById('root')!).render(<App/>);
