# Preserve current user images while offloading older request images

When request images exceed a Copilot model or local resource limit, the adapter defaults to replacing eligible older request images rather than failing a long-running conversation, while strict mode remains available. Images from the most recent human-authored message are protected and cause a clear failure if they cannot all be retained; older tool-result images may be replaced by newer tool-result images. This balances conversation continuity with user intent, without changing the durable image history.
