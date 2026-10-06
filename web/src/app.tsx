import { DockviewReact, type DockviewReadyEvent, themeAbyss } from "dockview";
import { components } from "./panels";
import { persistLayout, restoreOrDefault, setApi } from "./layout";
import TopBar from "./components/TopBar";

export default function App() {
  const onReady = (event: DockviewReadyEvent) => {
    setApi(event.api);
    restoreOrDefault(event.api);
    event.api.onDidLayoutChange(() => persistLayout());
  };

  return (
    <div className="app">
      <TopBar />
      <div className="dock-wrap">
        <DockviewReact components={components} onReady={onReady} theme={themeAbyss} />
      </div>
    </div>
  );
}
