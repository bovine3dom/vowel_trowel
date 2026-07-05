import { render } from "solid-js/web";

import App from "./App";
import { loadLanguageDataset, readInitialLanguageId } from "./languages/load";
import "./styles.css";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Missing root element");
}

const dataset = await loadLanguageDataset(readInitialLanguageId());

render(() => <App dataset={dataset} />, root);
