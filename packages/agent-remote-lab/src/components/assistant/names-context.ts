import { createContext, useContext } from 'react';
import { accountNames, type AccountNames } from '../../assistant-names.js';

/** The names the account's assistants are called by; the Workbench provides them from its groups. */
export const AssistantNamesContext = createContext<AccountNames>(accountNames([]));
export const useAssistantNames = (): AccountNames => useContext(AssistantNamesContext);
