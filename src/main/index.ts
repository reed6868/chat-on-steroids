// Restore external ownership before the unchanged application bootstrap can recover bridge
// commands. The controller server itself still waits for Electron ready.
import './external-controller-bootstrap.js';
import './index-app.js';
