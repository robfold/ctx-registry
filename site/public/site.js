// Copy buttons on code blocks, and the "Get your URL" form.
const ko = document.documentElement.lang === "ko";
const t = ko
  ? { copy: "복사", copied: "복사됨", select: "직접 선택해 복사하세요", ok: "받았습니다. 주소가 준비되면 이 이메일로 보내 드립니다.", email: "이메일 형식을 확인해 주세요.", fail: "보내지 못했습니다. 잠시 뒤 다시 눌러 주세요.", sending: "보내는 중…" }
  : { copy: "Copy", copied: "Copied", select: "Select the text to copy", ok: "Got it. We'll email your URL when it's ready.", email: "Check the email address.", fail: "Couldn't send. Try again in a moment.", sending: "Sending…" };

for (const block of document.querySelectorAll(".code")) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "copy";
  button.textContent = t.copy;
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(block.querySelector("code").innerText);
      button.textContent = t.copied;
      setTimeout(() => { button.textContent = t.copy; }, 1800);
    } catch {
      button.textContent = t.select;
    }
  });
  block.append(button);
}

const form = document.getElementById("signup");
const status = document.getElementById("signup-status");
if (form && status) {
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(data.email || "").trim())) {
      status.dataset.state = "error";
      status.textContent = t.email;
      form.elements.email.focus();
      return;
    }
    const button = form.querySelector("button[type=submit]");
    button.disabled = true;
    status.dataset.state = "";
    status.textContent = t.sending;
    try {
      const res = await fetch("/api/signup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...data, lang: ko ? "ko" : "en" }),
      });
      if (res.status === 400) throw Object.assign(new Error("email"), { email: true });
      if (!res.ok) throw new Error("fail");
      status.dataset.state = "ok";
      status.textContent = t.ok;
      form.reset();
    } catch (err) {
      status.dataset.state = "error";
      status.textContent = err.email ? t.email : t.fail;
    } finally {
      button.disabled = false;
    }
  });
}
