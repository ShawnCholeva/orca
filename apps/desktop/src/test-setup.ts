// Configure React 18 act() environment for vitest
// @ts-expect-error — IS_REACT_ACT_ENVIRONMENT is a React internal global
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
