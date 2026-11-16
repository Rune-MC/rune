declare module "rune:dashboard/jsx-runtime" {
    export { Fragment, jsx, jsxs, JSX } from "react/jsx-runtime";
}

declare module "rune:dashboard" {
    export { createElement, Fragment, useContext, useId } from "react";
    import type { ReactNode } from "react";
    export function Table(props: { title: string; columns: string[]; rows: { key: string | number; cells: ReactNode[] }[]; empty?: string }): ReactNode;
    export function Details(props: { values: Record<string, ReactNode> }): ReactNode;
    export function Card(props: { title: string; children: ReactNode }): ReactNode;
}
