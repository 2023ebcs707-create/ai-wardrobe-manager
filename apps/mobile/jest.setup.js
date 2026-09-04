// React 19 requires this flag for act()-aware concurrent rendering under Jest.
// jest-expo's preset does not set it, and without it React warns on every state
// update that happens outside act() — which would break the pristine-output rule.
global.IS_REACT_ACT_ENVIRONMENT = true;

// jest-expo mocks `react-native/Libraries/Core/InitializeCore` (the module that
// normally installs RN's FormData polyfill as the global on a real device), so
// without this, Node's built-in FormData (undici, global since Node 18) fills
// the gap in tests instead. Undici's FormData silently stringifies any
// non-Blob value passed to `append` (`String(value)` -> "[object Object]"),
// so a Task 7 upload test asserting a `{ uri, name, type }` file part
// survived intact in the multipart body would pass even if the real upload
// path silently dropped the file. Install the same FormData implementation
// the app itself uses at runtime, so tests exercise real behaviour instead of
// a Jest-environment artifact.
global.FormData = require('react-native/Libraries/Network/FormData').default;
