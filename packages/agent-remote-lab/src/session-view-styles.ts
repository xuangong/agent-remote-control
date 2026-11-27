// Keep the product and standalone Session View cascade in the same order.
import '@orchardworks/agent-client-web/theme.css';
import './ui/tokens.css';
import './app.css';
import '@orchardworks/agent-client-web/styles.css';
import './conversation/session-view-responsive.css';
import './conversation/session-view-options.css';
import './features/team/ask-resize.css';
import './ui/ui.css';
import '@orchardworks/agent-client-web/primitives.css';
import './shell/touch.css';
import { enableTouchPressedState } from './kernel/touch-feedback.js';

if (typeof document !== 'undefined') enableTouchPressedState(document);
