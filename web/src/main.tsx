import { createRoot } from "react-dom/client";
import { App } from "./app";
import "./styles.css";

document.documentElement.classList.add("dark"); // shadcn dark-mode token scope
createRoot(document.getElementById("root")!).render(<App />);
