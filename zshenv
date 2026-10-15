[ -r "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"

# Android: one SDK shared by Android Studio and the CLI; Studio's bundled JDK runs the SDK tools.
export ANDROID_HOME="$HOME/Library/Android/sdk"
[ -d "/Applications/Android Studio.app/Contents/jbr/Contents/Home" ] && export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"

typeset -U path PATH
path=(
  "$HOME/Developer/personal/dotfiles/claude/bin"
  "$HOME/.local/bin"
  "$HOME/.bun/bin"
  "$ANDROID_HOME/platform-tools"  # ahead of brew's adb so Studio and the shell share one adb server
  "$ANDROID_HOME/emulator"
  "$ANDROID_HOME/cmdline-tools/latest/bin"
  /opt/homebrew/bin
  $path
)
export PATH
