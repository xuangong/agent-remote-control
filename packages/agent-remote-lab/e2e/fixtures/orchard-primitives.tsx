// Every Orchard primitive in every state, built from props: no client, Relay or Controller.
// ?theme=light|dark|system sets the appearance; ?motion=off replaces the motion port with reduced motion; ?width=phone narrows the page.
import { useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { bindAppearance } from '@orchardworks/agent-client-web/browser';
import {
  ApprovalCard, AssistantAvatar, Bubble, Card, FloatingPanel, MotionProvider, OrchardMark, Pill, SegmentedControl, SessionChangeLine, Sheet,
  StatusLine, Toggle, WorkSummaryLine, Wordmark, browserMotionPort, type MotionPort,
} from '@orchardworks/agent-client-web/primitives';
import { avatarGazes, avatarPalette, avatarShapeNames, type AvatarMood } from '@orchardworks/agent-client-web/theme';
import '../../src/session-view-styles';
import './orchard-primitives.css';

const params = new URLSearchParams(location.search);
const appearance = bindAppearance(document, localStorage);
const theme = params.get('theme');
if (theme === 'light' || theme === 'dark' || theme === 'system') appearance.set(theme);
Object.assign(window, { orchardAppearance: appearance });
const port: MotionPort = params.get('motion') === 'off'
  ? { read: () => ({ reducedMotion: true, pageVisible: true }), subscribe: () => () => {} }
  : browserMotionPort();
if (params.get('width') === 'phone') document.documentElement.dataset.width = 'phone';

const moods: readonly AvatarMood[] = ['idle', 'working', 'needs_you', 'resting'];
const sizes = [16, 23, 24, 28, 40, 84];

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return <section className="fixture-section" data-section={id} aria-labelledby={`${id}-title`}>
    <h2 id={`${id}-title`}>{title}</h2>{children}
  </section>;
}

function Conversation() {
  const [open, setOpen] = useState(false);
  const chief = <AssistantAvatar id="chief" picture={{ shape: 'triangle', color: '#ff8a3d', gaze: 1 }} size={28} />;
  return <FloatingPanel label="Conversation" className="fixture-panel">
    <div className="fixture-column">
      <Bubble from="mine">帮我整理一份 IM 设计原则，写进 notes.md，再讲讲每条？</Bubble>
      <WorkSummaryLine summary="翻了 3 个文件，写好了 notes.md" open={open} onToggle={() => setOpen(value => !value)}>
        <ul><li>Read docs/principles.md</li><li>Edited notes.md (+24 −2)</li><li>Ran pnpm lint</li></ul>
      </WorkSummaryLine>
      <Bubble from="theirs" avatar={chief}>好了！我挑了三条：内容先到，发送不等待，过程可选。</Bubble>
      <Bubble from="theirs" avatar={chief}>
        A long line without spaces: notes/principles/instant-messaging/content-first/send-never-waits/process-optional.md
        <pre><code>{'pnpm test:unit agent-client-web src/primitives\n✓ 24 passed'}</code></pre>
      </Bubble>
      <SessionChangeLine>换到新的会话继续</SessionChangeLine>
      <Bubble from="theirs" avatar={chief}>
        <ApprovalCard prompt="我想在 notes.md 里加一小段例子，可以吗？"
          choices={[{ label: '好的', primary: true, onChoose: () => {} }, { label: '先别', onChoose: () => {} }, { label: '看看要改什么', onChoose: () => {} }]} />
      </Bubble>
      <StatusLine avatar={<AssistantAvatar id="chief" picture={{ shape: 'triangle', color: '#ff8a3d', gaze: 1 }} size={40} mood="working" />}
        sentence="Chief 在想例子怎么写" detail="认真工作中" live />
      <StatusLine sentence="Reviewer 看完啦，有 3 点想法" />
      <Bubble from="mine" delivery="sending" sendingLabel="发送中">顺便把标题改成「IM 原则」</Bubble>
    </div>
  </FloatingPanel>;
}

function Controls() {
  const [mode, setMode] = useState<'bot' | 'window'>('bot');
  const [process, setProcess] = useState<'brief' | 'steps' | 'full'>('brief');
  const [on, setOn] = useState(true);
  const [off, setOff] = useState(false);
  const [sheet, setSheet] = useState(false);
  return <div className="fixture-stack">
    <div className="fixture-row"><Pill variant="primary">好的</Pill><Pill>先别</Pill><Pill disabled>Disabled</Pill></div>
    <SegmentedControl label="Workbench mode" value={mode} onChange={setMode} options={[{ value: 'bot', label: 'Bot mode' }, { value: 'window', label: 'Window mode' }]} />
    <SegmentedControl label="Process" value={process} onChange={setProcess}
      options={[{ value: 'brief', label: '简洁' }, { value: 'steps', label: '过程' }, { value: 'full', label: '完整' }]} />
    <div className="fixture-group">
      <Toggle checked={on} label="Notifications" onChange={setOn} />
      <Toggle checked={off} label="Sounds" onChange={setOff} />
      <Toggle checked label="Managed by your Host" onChange={() => {}} disabled />
    </div>
    <Card>A plain card on the fill.</Card>
    <Card tone="tint"><strong>Chief</strong> · 你的 AI 助手</Card>
    <div className="fixture-row"><Pill data-testid="open-sheet" onClick={() => setSheet(true)}>Open sheet</Pill></div>
    <Sheet open={sheet} title="Chief" detent="content" onClose={() => setSheet(false)}>
      <p className="fixture-text">The details panel slides up from the assistant's name at phone width.</p>
    </Sheet>
  </div>;
}

function Avatars() {
  return <div className="fixture-stack">
    <h3>Shapes × colours, 40 px</h3>
    <div className="fixture-grid" data-testid="avatar-grid">
      {avatarShapeNames.flatMap(shape => avatarPalette.map(color =>
        <AssistantAvatar key={`${shape}-${color.name}`} id={`${shape}-${color.name}`} picture={{ shape, color: color.value }} size={40} label={`${shape} ${color.name}`} />))}
    </div>
    <h3>Gazes</h3>
    <div className="fixture-row">{avatarGazes.map(gaze => <AssistantAvatar key={gaze} id={`gaze-${gaze}`} picture={{ shape: 'circle', color: '#3d8bff', gaze }} size={40} label={`gaze ${gaze}`} />)}</div>
    <h3>Moods and sizes</h3>
    {moods.map(mood => <div key={mood} className="fixture-row" data-mood-row={mood}>
      <span className="fixture-caption">{mood}</span>
      {sizes.map(size => <AssistantAvatar key={size} id={`mood-${mood}`} size={size} mood={mood} />)}
    </div>)}
    <h3>Stored picture</h3>
    <div className="fixture-row"><AssistantAvatar id="override" picture={{ shape: 'squircle', color: '#22b3c2', gaze: 0 }} size={84} label="Stored squircle" /></div>
  </div>;
}

function Brand() {
  return <div className="fixture-stack">
    <div className="fixture-row fixture-marks">{[16, 20, 32, 64, 150].map(size => <OrchardMark key={size} size={size} title={`Orchard ${size}`} />)}</div>
    <div className="fixture-row"><span className="fixture-on-surface"><Wordmark /></span><span className="fixture-on-ground"><Wordmark /></span></div>
  </div>;
}

function Legacy() {
  return <div className="fixture-stack">
    <p className="fixture-legacy" data-testid="legacy">Legacy --ui-label on --ui-background</p>
  </div>;
}

createRoot(document.getElementById('root')!).render(<MotionProvider port={port}>
  <main className="fixture-page">
    <h1 className="fixture-title">Orchard primitives</h1>
    <Section id="conversation" title="Conversation"><Conversation /></Section>
    <Section id="controls" title="Controls"><Controls /></Section>
    <Section id="avatars" title="Avatars"><Avatars /></Section>
    <Section id="brand" title="Mark and wordmark"><Brand /></Section>
    <Section id="legacy" title="Legacy tokens"><Legacy /></Section>
  </main>
</MotionProvider>);
