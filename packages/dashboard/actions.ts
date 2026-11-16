export class InvalidForm extends Error {}

export function readFields(form: URLSearchParams, schema: Record<string, RuneDashboardField>) {
  for (const name of new Set(form.keys())) {
    if (form.getAll(name).length !== 1 || !["csrf", "confirm"].includes(name) && !Object.hasOwn(schema, name)) {
      throw new InvalidForm("The form contains an unexpected or repeated field.");
    }
  }
  const values: Record<string, RuneDashboardValue> = Object.create(null);
  for (const [name, field] of Object.entries(schema)) {
    const value = form.get(name);
    const label = field.label ?? name;
    if (field.type === "boolean") {
      if (value !== null && value !== "true" || field.required && value !== "true") throw new InvalidForm(`Check ${label}.`);
      values[name] = value === "true";
      continue;
    }
    if (value === null || !value.trim()) {
      if (field.required) throw new InvalidForm(`Enter ${label}.`);
      if (field.type === "string" && !field.choices && value !== null) values[name] = value;
      continue;
    }
    if (field.type === "number") {
      const number = Number(value);
      if (!Number.isFinite(number) || number < (field.min ?? -Infinity) || number > (field.max ?? Infinity)) {
        throw new InvalidForm(`${label} is outside its allowed range.`);
      }
      values[name] = number;
    } else {
      if (value.length > (field.maxLength ?? 4096) || field.choices && !Object.hasOwn(field.choices, value)) {
        throw new InvalidForm(`Enter a valid value for ${label}.`);
      }
      values[name] = value;
    }
  }
  return Object.freeze(values);
}
