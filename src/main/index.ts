// Keep the application bootstrap intact and layer the independent loopback controller beside it.
// Both modules share the same broker/bridge singletons; the external surface owns no window.
import './index-app.js';
import './external-controller-bootstrap.js';
