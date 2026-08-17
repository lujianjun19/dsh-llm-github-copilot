    let localeRuntime;
    const localeSubscribe = (listener) => localeRuntime === void 0 ? () => {} : localeRuntime.subscribe(listener);
    const localeSnapshot = () => localeRuntime?.getSnapshot().revision ?? 0;
    function format(template, params) {
      if (params === void 0) return template;
      return template.replace(/\{([^}]+)\}/g, (match, key) => key in params ? String(params[key]) : match);
    }
    function text(key, params) {
      // Follow the Harness locale exactly; any unknown/unavailable locale falls
      // back to English as this plugin's explicit default.
      const dictionary = localeRuntime?.getSnapshot().active === "zh" ? ZH : EN;
      return format(dictionary[key] ?? EN[key] ?? key, params);
    }
    function useLocaleRevision() {
      useSyncExternalStore(localeSubscribe, localeSnapshot, () => 0);
    }

