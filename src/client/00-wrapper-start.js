window.__ModuleLoader__.load({
  id: "@deepseek-ai/dsh-llm-github-copilot",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const React = require("react");
    const { jsx, jsxs } = require("react/jsx-runtime");
    const {
      Button,
      Input,
      Modal,
      RiskConfirmation,
      StateDot,
      writeClipboard
    } = require("@deepseek-ai/dsh-client-ui-primitives");
    const { useEffect, useState, useSyncExternalStore } = React;

