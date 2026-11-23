import { useCallback, useContext, useState, type ComponentProps } from 'react';
import type { Team } from '@orchardworks/agent-remote-protocol';
import { ConversationConnectionScope } from '../../conversation/conversation-connections.js';
import { useTeamRoster } from '../../kernel/useTeamRoster.js';
import { TeamMenu } from './TeamMenu.js';

type MenuProps = Omit<ComponentProps<typeof TeamMenu>, 'teams' | 'roster' | 'onTeamChange'>;
/** The Team menu with the roster loader the page gives it. */
export function TeamMenuHarness({ onTeamsChange, following, ...props }: MenuProps & { following?: boolean; onTeamsChange?(baseUrl: string, teams: Team[]): void }) {
  const connections = useContext(ConversationConnectionScope);
  const [roster, setRoster] = useState<{ baseUrl: string; teams: Team[] }>();
  const publish = useCallback((baseUrl: string, teams: Team[]) => { setRoster({ baseUrl, teams }); onTeamsChange?.(baseUrl, teams); }, [onTeamsChange]);
  const teams = roster?.baseUrl === props.baseUrl ? roster.teams : undefined;
  const loader = useTeamRoster({ baseUrl: props.baseUrl, enabled: props.enabled, following, teams, publish, connections });
  return <TeamMenu {...props} teams={teams} roster={loader}
    onTeamChange={(baseUrl, team) => {
      const next = [...(roster?.baseUrl === baseUrl ? roster.teams : []).filter(value => value.id !== team.id), team];
      setRoster({ baseUrl, teams: next }); onTeamsChange?.(baseUrl, next);
    }} />;
}
