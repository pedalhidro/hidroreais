import { render } from "preact";
import { registerSW } from "virtual:pwa-register";
import { useIdentity } from "./lib/identity";
import { useRoute } from "./lib/router";
import { Bank } from "./views/Bank";
import { Devices, LinkDevice } from "./views/Devices";
import { External } from "./views/External";
import { Home } from "./views/Home";
import { NewDevice } from "./views/NewDevice";
import { Pay } from "./views/Pay";
import { Receive } from "./views/Receive";
import { Transparency } from "./views/Transparency";
import { Welcome } from "./views/Welcome";
import "./styles.css";

function App() {
  const route = useRoute();
  const identity = useIdentity();

  // Pages that work without an account on this device.
  switch (route.path) {
    case "/new-device":
      return <NewDevice />;
    case "/transparency":
      return <Transparency />;
    case "/external":
      return <External route={route} />;
    case "/bank":
      return <Bank route={route} />;
  }

  if (!identity) return <Welcome route={route} />;

  switch (route.path) {
    case "/pay":
      return <Pay identity={identity} route={route} />;
    case "/receive":
      return <Receive identity={identity} />;
    case "/devices":
      return <Devices identity={identity} />;
    case "/link":
      return <LinkDevice identity={identity} route={route} />;
    default:
      return <Home identity={identity} />;
  }
}

registerSW({ immediate: true });
render(<App />, document.getElementById("app")!);
