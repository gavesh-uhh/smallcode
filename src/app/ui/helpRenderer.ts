import { HELP_COMMANDS, MISSION_COMMANDS, SHORTCUTS } from "../commands/commandDefinitions.ts";
import { style } from "../../ui/tui/style.ts";
import type { ViewModel } from "../../ui/tui/viewModel.ts";

export function renderHelp(vm: ViewModel): void {
  vm.addInfo("");

  vm.addInfo(`  ${style.bold(style.cyan("─── General Commands ───"))}`);
  for (const [cmd, desc] of HELP_COMMANDS.general) {
    vm.addInfo(`  ${style.yellow(cmd.padEnd(28))} ${style.dim(desc)}`);
  }

  vm.addInfo(`\n  ${style.bold(style.cyan("─── Sub-Tools ───"))}`);
  for (const [cmd, desc] of HELP_COMMANDS.tools) {
    vm.addInfo(`  ${style.yellow(cmd.padEnd(28))} ${style.dim(desc)}`);
  }

  vm.addInfo(`\n  ${style.bold(style.cyan("─── Agent Sessions ───"))}`);
  for (const [cmd, desc] of HELP_COMMANDS.agent) {
    vm.addInfo(`  ${style.yellow(cmd.padEnd(28))} ${style.dim(desc)}`);
  }

  vm.addInfo(`\n  ${style.bold(style.cyan("─── Multi-Agent ───"))}`);
  for (const [cmd, desc] of MISSION_COMMANDS) {
    vm.addInfo(`  ${style.yellow(cmd.padEnd(28))} ${style.dim(desc)}`);
  }

  vm.addInfo(`\n  ${style.bold(style.cyan("─── Shortcuts ───"))}`);
  for (const [cmd, desc] of SHORTCUTS) {
    vm.addInfo(`  ${style.yellow(cmd.padEnd(28))} ${style.dim(desc)}`);
  }
  vm.addInfo("");
}
