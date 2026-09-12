const $ = (selector) => document.querySelector(selector);
let csrf = "",
  mode = "loading",
  enrollment = "",
  onSignedIn;
let submitting = false;
export async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    credentials: "same-origin",
    cache: "no-store",
    signal: AbortSignal.timeout(15000),
    headers: {
      ...(options.method && options.method !== "GET"
        ? { "content-type": "application/json", "x-csrf-token": csrf }
        : {}),
      ...options.headers,
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok)
    throw Object.assign(
      new Error(data.error || "Could not connect. Try again."),
      { status: response.status },
    );
  return data;
}
const post = (url, body) =>
  api(url, { method: "POST", body: JSON.stringify(body) });
function updateResetFields() {
  const reset = mode === "reset";
  const admin = $("#resetMethod").value === "admin";
  $("#resetFields").hidden = !reset;
  $("#resetAdminFields").hidden = !admin;
  $("#resetRecoveryFields").hidden = admin;
  for (const id of ["resetEmail", "resetPassword", "resetPasswordConfirm", "resetMethod"])
    $("#" + id).disabled = !reset || submitting;
  $("#resetAdminCode").disabled = !reset || !admin || submitting;
  $("#resetRecoveryCode").disabled = $("#resetAuthenticatorCode").disabled = !reset || admin || submitting;
}
function eraseReset() {
  for (const id of ["resetRecoveryCode", "resetAuthenticatorCode", "resetAdminCode", "resetPassword", "resetPasswordConfirm"])
    $("#" + id).value = "";
}
function showMode(next) {
  mode = next;
  const setup = mode === "setup",
    login = mode === "login",
    challenge = mode === "challenge",
    recovery = mode === "recovery";
  $("#accountFields").hidden = !(setup || login);
  $("#ownershipField").hidden = !setup;
  $("#loginCodeField").hidden = !login;
  $("#enrollmentFields").hidden = !challenge;
  $("#recoveryFields").hidden = !recovery;
  $("#tokenInput").disabled = !setup;
  $("#emailInput").disabled = $("#passwordInput").disabled = !(setup || login);
  $("#loginCode").disabled = !login;
  $("#setupCode").disabled = !challenge;
  $("#passwordInput").minLength = setup ? 15 : 1;
  $("#passwordInput").autocomplete = setup
    ? "new-password"
    : "current-password";
  $("#connectButton").hidden = recovery;
  $("#connectButton").disabled = mode === "loading";
  $("#restartSetup").hidden = !challenge;
  $("#forgotPassword").hidden = !login;
  $("#backToLogin").hidden = mode !== "reset";
  updateResetFields();
  const copy = {
    loading: ["Opening AgentPulse…", "Checking your account.", "Continue"],
    retry: [
      "Connection unavailable",
      "Check your connection, then try again.",
      "Retry connection",
    ],
    setup: [
      "Create your private account",
      "Confirm ownership, then choose a password of at least 15 characters. Your email is your sign-in name; no email service is needed.",
      "Set up authenticator",
    ],
    login: [
      "Welcome back",
      "Sign in to your private AgentPulse inbox.",
      "Sign in",
    ],
    reset: [
      "Reset your password",
      "Verify ownership, then choose a new password. AgentPulse does not send password-reset emails.",
      "Reset password",
    ],
    challenge: [
      "Connect your authenticator",
      "Scan the QR code, then enter the code from your authenticator.",
      "Verify authenticator",
    ],
    recovery: [
      "Save your recovery codes",
      "Your account is ready. Keep a way back in.",
      "Continue",
    ],
  }[mode];
  $("#loginTitle").textContent = copy[0];
  $("#loginHint").textContent = copy[1];
  $("#connectButton").textContent = copy[2];
}
function eraseEnrollment() {
  enrollment = "";
  $("#totpQr").removeAttribute("src");
  $("#totpSecret").textContent = "";
  $("#setupCode").value = "";
  $("#recoveryCodes").textContent = "";
}
export function clearAuth() {
  csrf = "";
  eraseEnrollment();
  eraseReset();
  $("#passwordInput").value = "";
  $("#loginCode").value = "";
  showMode("login");
}
async function restore() {
  showMode("loading");
  $("#loginError").hidden = true;
  try {
    const status = await api("/api/auth/status");
    showMode(status.configured ? "login" : "setup");
    if (status.authenticated) {
      csrf = status.csrf;
      await onSignedIn();
    }
  } catch {
    showMode("retry");
  }
}
export async function signOut() {
  const registration = await navigator.serviceWorker?.getRegistration();
  const sub = await registration?.pushManager?.getSubscription();
  try {
    await post("/api/auth/logout", { endpoint: sub?.endpoint });
  } catch (error) {
    if (error.status !== 401) throw error;
  }
  // Server removal happens first, so a browser unsubscribe error cannot keep alerts enabled.
  await sub?.unsubscribe().catch(() => {});
  const notifications = await registration?.getNotifications();
  notifications?.forEach((n) => n.close());
  clearAuth();
}
export function initAuth(callback) {
  onSignedIn = callback;
  try {
    localStorage.removeItem("agentpulse_mobile_token");
  } catch {}
  $("#loginForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (submitting) return;
    if (mode === "retry") return restore();
    submitting = true;
    $("#connectButton").disabled = true;
    $("#loginError").hidden = true;
    $("#loginNotice").hidden = true;
    $("#forgotPassword").disabled = $("#backToLogin").disabled = true;
    try {
      if (mode === "setup") {
        const data = await post("/api/auth/setup", {
          token: $("#tokenInput").value.trim(),
          email: $("#emailInput").value,
          password: $("#passwordInput").value,
        });
        $("#tokenInput").value = $("#passwordInput").value = "";
        enrollment = data.enrollment;
        $("#totpQr").src = data.qr;
        $("#totpSecret").textContent = new URL(data.uri).searchParams.get(
          "secret",
        );
        showMode("challenge");
        $("#setupCode").focus();
      } else if (mode === "challenge") {
        const data = await post("/api/auth/confirm", {
          enrollment,
          code: $("#setupCode").value.trim(),
        });
        csrf = data.csrf;
        eraseEnrollment();
        $("#recoveryCodes").textContent = data.recoveryCodes.join("\n");
        showMode("recovery");
        $("#savedRecovery").focus();
      } else if (mode === "reset") {
        const admin = $("#resetMethod").value === "admin";
        const email = $("#resetEmail").value;
        const body = {
          email,
          password: $("#resetPassword").value,
          confirmPassword: $("#resetPasswordConfirm").value,
          ...(admin
            ? { resetToken: $("#resetAdminCode").value.trim() }
            : { recoveryCode: $("#resetRecoveryCode").value.trim(), code: $("#resetAuthenticatorCode").value.trim() }),
        };
        updateResetFields();
        await post("/api/auth/reset-password", body);
        eraseReset();
        csrf = "";
        $("#emailInput").value = email;
        $("#passwordInput").value = $("#loginCode").value = "";
        showMode("login");
        $("#loginNotice").textContent = "Password reset. Sign in with your new password and a fresh authenticator code. All previous sessions have been signed out.";
        $("#loginNotice").hidden = false;
        $("#passwordInput").focus();
      } else if (mode === "login") {
        const data = await post("/api/auth/login", {
          email: $("#emailInput").value,
          password: $("#passwordInput").value,
          code: $("#loginCode").value.trim(),
        });
        csrf = data.csrf;
        $("#passwordInput").value = $("#loginCode").value = "";
        await onSignedIn();
        if (data.recoveryUsed) {
          $("#announcement").textContent =
            `Recovery code used. ${data.recoveryRemaining} remain. Keep your remaining codes safe.`;
          $("#announcement").hidden = false;
        }
      }
    } catch (error) {
      $("#loginError").textContent = error.status
        ? error.message
        : "Could not connect. Check your connection and try again.";
      $("#loginError").hidden = false;
      if (error.status === 409 && ["setup", "challenge"].includes(mode)) {
        eraseEnrollment();
        showMode("login");
      }
    } finally {
      submitting = false;
      $("#connectButton").disabled = false;
      $("#forgotPassword").disabled = $("#backToLogin").disabled = false;
      updateResetFields();
    }
  });
  $("#forgotPassword").addEventListener("click", () => {
    if (submitting) return;
    $("#resetEmail").value = $("#emailInput").value;
    $("#passwordInput").value = $("#loginCode").value = "";
    $("#loginError").hidden = $("#loginNotice").hidden = true;
    eraseReset();
    showMode("reset");
    $("#resetEmail").focus();
  });
  $("#backToLogin").addEventListener("click", () => {
    if (submitting) return;
    eraseReset();
    $("#loginError").hidden = true;
    showMode("login");
    $("#emailInput").focus();
  });
  $("#resetMethod").addEventListener("change", () => {
    $("#resetRecoveryCode").value = $("#resetAuthenticatorCode").value = $("#resetAdminCode").value = "";
    updateResetFields();
  });
  $("#restartSetup").addEventListener("click", () => {
    eraseEnrollment();
    showMode("setup");
    $("#tokenInput").focus();
  });
  $("#savedRecovery").addEventListener("click", async () => {
    eraseEnrollment();
    await onSignedIn();
  });
  return restore();
}
