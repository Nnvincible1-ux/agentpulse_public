import { api } from "./auth.js";
const $ = (selector) => document.querySelector(selector);
let registration,
  publicKey,
  currentSub,
  initialized = false;
const post = (url, body) =>
  api(url, { method: "POST", body: JSON.stringify(body) });
function controls(enabled) {
  $("#pushSetup").hidden = enabled;
  $("#pushTest").hidden = $("#pushDisable").hidden = !enabled;
}
function message(text) {
  $("#pushStatus").textContent = text;
}
function failure(error) {
  message(
    error.status === 401
      ? "Your session ended. Sign in again."
      : error.status
        ? error.message
        : "Could not update notifications. Check your connection and retry.",
  );
}
export async function initNotifications() {
  if (
    !("serviceWorker" in navigator) ||
    !("PushManager" in window) ||
    !("Notification" in window) ||
    !window.isSecureContext
  ) {
    message(
      "Open AgentPulse in Chrome on Android to enable notifications. On iPhone, install it on the Home Screen first.",
    );
    $("#pushSetup").disabled = true;
    return;
  }
  try {
    const config = await api("/api/mobile/config");
    publicKey = config.pushPublicKey;
    registration = await navigator.serviceWorker.register("/sw.js");
    await navigator.serviceWorker.ready;
    currentSub = await registration.pushManager.getSubscription();
    if (currentSub && Notification.permission === "granted") {
      await post("/api/mobile/push/subscribe", currentSub.toJSON());
      controls(true);
      message(
        "Notifications are enabled on this device. Send a test to check delivery.",
      );
    } else {
      controls(false);
      message(
        Notification.permission === "denied"
          ? "Notifications are blocked. Allow them in your browser’s settings for this site, then reload."
          : "Enable alerts here to hear when your agent needs you, even with AgentPulse closed.",
      );
    }
  } catch (error) {
    failure(error);
  }
  if (initialized) return;
  initialized = true;
  $("#pushSetup").addEventListener("click", async () => {
    $("#pushSetup").disabled = true;
    try {
      // Request permission directly from the user's click, before any network work.
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        message(
          "Notifications are not allowed. You can change this in your browser’s site settings.",
        );
        return;
      }
      if (!registration || !publicKey) {
        await initNotifications();
        if (!registration || !publicKey) return;
      }
      currentSub =
        (await registration.pushManager.getSubscription()) ||
        (await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: publicKey,
        }));
      await post("/api/mobile/push/subscribe", currentSub.toJSON());
      controls(true);
      message(
        "Notifications are enabled. Send a test, then close AgentPulse to check background delivery.",
      );
    } catch (error) {
      failure(error);
    } finally {
      $("#pushSetup").disabled = false;
    }
  });
  $("#pushTest").addEventListener("click", async () => {
    $("#pushTest").disabled = true;
    try {
      currentSub = await registration.pushManager.getSubscription();
      const result = await post("/api/mobile/push/test", {
        endpoint: currentSub?.endpoint,
      });
      message(
        result.sent
          ? "Test sent to your browser’s push service. Check your phone for the notification."
          : "The push service rejected the test. Disable notifications here, then enable them again.",
      );
    } catch (error) {
      failure(error);
    } finally {
      $("#pushTest").disabled = false;
    }
  });
  $("#pushDisable").addEventListener("click", async () => {
    $("#pushDisable").disabled = true;
    try {
      currentSub = await registration.pushManager.getSubscription();
      if (currentSub) {
        await post("/api/mobile/push/unsubscribe", {
          endpoint: currentSub.endpoint,
        });
        await currentSub.unsubscribe();
      }
      currentSub = null;
      controls(false);
      message("Notifications are disabled on this device.");
    } catch (error) {
      failure(error);
    } finally {
      $("#pushDisable").disabled = false;
    }
  });
}
