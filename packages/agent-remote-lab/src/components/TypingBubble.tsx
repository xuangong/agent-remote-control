import './typing-bubble.css';

/**
 * A bot at work, as a chat shows a contact typing: three dots in an incoming bubble below its latest reply. It covers
 * hidden reasoning and tool work, is not a message and moves nothing.
 */
export function TypingBubble({ name }: { name: string }) {
  return <div className="lab-typing" role="status" aria-label={`${name} is working`}><span /><span /><span /></div>;
}

/** The same dots, small, where a row would say Working. */
export function TypingDots() {
  return <span className="lab-bot-typing" aria-hidden="true"><span /><span /><span /></span>;
}
