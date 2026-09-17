import { initBotId } from "botid/client/core";

initBotId({
  protect: [
    { path: "/api/r/*/reviews", method: "POST" },
    { path: "/r/*", method: "GET" },
  ],
});
