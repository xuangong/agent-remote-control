/** A sleeping bot: quiet, with Wake, which wakes it for every device. Its conversation is released until then. */
export function AsleepNotice({ onWake }: { onWake(): void }) {
  return <p className="lab-bot-asleep" role="status">Asleep. Its conversation catches up when it wakes.{' '}
    <button type="button" onClick={onWake}>Wake</button></p>;
}
