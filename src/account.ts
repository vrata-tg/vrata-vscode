import { AccountSnapshot } from "./gateway";

export function rubles(atoms: string): string {
  const value = BigInt(atoms);
  const whole = (value / 1_000_000n).toLocaleString("ru-RU");
  const fraction = (value % 1_000_000n)
    .toString()
    .padStart(6, "0")
    .replace(/0+$/, "");
  return `${whole}${fraction ? `,${fraction}` : ""} ₽`;
}

export function accountTooltip(account: AccountSnapshot): string {
  const { balance, quota } = account;
  return [
    `На счёте доступно: ${rubles(balance.spendable)}`,
    `Оплачено: ${rubles(balance.paid_available)}`,
    `Промо: ${rubles(balance.promo_available)}`,
    `Зарезервировано отдельно: ${rubles(balance.reserved)}`,
    quota.remaining === null
      ? quota.limit === null
        ? "Лимит ключа: не задан"
        : `Лимит ключа: ${rubles(quota.limit)}; актуальный остаток недоступен`
      : `Остаток лимита ключа: ${rubles(quota.remaining)}`,
  ].join("\n");
}
