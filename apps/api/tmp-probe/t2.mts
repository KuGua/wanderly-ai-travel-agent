const { requestsUnsupportedOperationalFacts, containsUnsupportedOperationalClaim } =
  await import("../src/policy/conversation-safety.js");
const qs = [
  "一个人一间房，12月20日到25日，100人民币到500",
  "一个人一间房，12月20日到25日",
  "100人民币到500",
  "1成人1间房，人民币报价",
  "预算100到500人民币",
  "一间房",
];
for (const q of qs) {
  console.log(requestsUnsupportedOperationalFacts(q) ? "输入门拦截 ❌" : "输入门放行 ✅", "|", q);
}
