#!/usr/bin/env node

import { render } from "ink";
import { createElement } from "react";
import { App } from "./ui/app.tsx";

render(createElement(App));
