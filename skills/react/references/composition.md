# Composition Over Configuration

Avoid monolithic components with boolean props. Use composition with compound components and injectable context.

## Boolean Prop Explosion → Explicit Variants

Each boolean doubles possible states. Five booleans = 32 branches to reason about.

```tsx
// BAD: Monolithic component with flags
<Composer isThread isEditing={false} showAttachments channelId="abc" />

// GOOD: Explicit variant components
<ThreadComposer channelId="abc" />
<EditComposer messageId="123" />
```

Each variant wraps its own provider and composes only what it needs:

```tsx
function ThreadComposer({ channelId }: { channelId: string }) {
  return (
    <ThreadProvider channelId={channelId}>
      <Composer.Frame>
        <Composer.Input />
        <AlsoSendToChannelField channelId={channelId} />
        <Composer.Footer>
          <Composer.Formatting />
          <Composer.Submit />
        </Composer.Footer>
      </Composer.Frame>
    </ThreadProvider>
  );
}

function EditComposer({ messageId }: { messageId: string }) {
  return (
    <EditMessageProvider messageId={messageId}>
      <Composer.Frame>
        <Composer.Input />
        <Composer.Footer>
          <Composer.CancelEdit />
          <Composer.SaveEdit />
        </Composer.Footer>
      </Composer.Frame>
    </EditMessageProvider>
  );
}
```

## Children Over Render Props

Use `children` for static structure. Reserve render props for when the parent must pass data back.

```tsx
// BAD: render prop explosion — awkward, inflexible
<Composer
  renderHeader={() => <CustomHeader />}
  renderFooter={() => <><Formatting /><Emojis /></>}
  renderActions={() => <SubmitButton />}
/>

// GOOD: children compose naturally
<Composer.Frame>
  <CustomHeader />
  <Composer.Input />
  <Composer.Footer>
    <Composer.Formatting />
    <Composer.Emojis />
    <SubmitButton />
  </Composer.Footer>
</Composer.Frame>

// EXCEPTION: render props when parent provides data to child
<List data={items} renderItem={({ item, index }) => <Item item={item} index={index} />} />
```

## Compound Components

Structure complex UIs as composable subcomponents with shared context:

```tsx
const Composer = {
  Provider: ComposerProvider,
  Frame: ComposerFrame,
  Input: ComposerInput,
  DropZone: ComposerDropZone,
  Submit: ComposerSubmit,
}

// Usage: render to opt-in
function ChannelComposer() {
  return (
    <Composer.Provider state={state} actions={actions}>
      <Composer.Frame>
        <Composer.Input />
        <Composer.DropZone /> {/* Just render to enable */}
        <Composer.Submit />
      </Composer.Frame>
    </Composer.Provider>
  );
}
```

## Generic Context Interface

Three-part contract: `state`, `actions`, `meta`. Any provider can implement it.

```tsx
interface ComposerContextValue {
  state: { input: string; attachments: File[]; isSubmitting: boolean }
  actions: { update: (text: string) => void; submit: () => void }
  meta: { inputRef: RefObject<HTMLTextAreaElement> }
}
```

## Decouple State From UI

Provider defines how state is managed. UI components only consume the interface. Different providers, same UI:

```tsx
// Local state provider
function LocalComposerProvider({ children }: { children: React.ReactNode }) {
  const [text, setText] = useState('');
  return (
    <ComposerContext value={{ state: { input: text }, actions: { update: setText, submit: () => {} } }}>
      {children}
    </ComposerContext>
  );
}

// Synced state provider — same UI, different backing store
function SyncedComposerProvider({ children }: { children: React.ReactNode }) {
  const { text, updateText, submit } = useSyncedComposer();
  return (
    <ComposerContext value={{ state: { input: text }, actions: { update: updateText, submit } }}>
      {children}
    </ComposerContext>
  );
}
```

## Lift Provider for Flexible Layouts

Components don't need to be visually nested — just within the same provider:

```tsx
// BAD: useEffect to sync child state up — fragile, fires every change
function ForwardMessageDialog() {
  const [input, setInput] = useState('');
  return (
    <Dialog>
      <ForwardMessageComposer onInputChange={setInput} />
      <MessagePreview input={input} />
    </Dialog>
  );
}

// BAD: stateRef hack — loses reactivity, read-on-submit only
function ForwardMessageDialog() {
  const stateRef = useRef(null);
  return (
    <Dialog>
      <ForwardMessageComposer stateRef={stateRef} />
      <ForwardButton onPress={() => submit(stateRef.current)} />
    </Dialog>
  );
}

// GOOD: Lift provider — siblings share state via context
function ForwardMessageModal() {
  return (
    <ForwardMessageProvider>
      <ComposerUI />
      <MessagePreview /> {/* Reads composer state via context */}
      <div className="modal-footer">
        <ForwardButton /> {/* Calls submit() via context */}
      </div>
    </ForwardMessageProvider>
  );
}
```

## React 19 API Changes

- `ref` is a regular prop — no `forwardRef` wrapper needed
- `use(MyContext)` replaces `useContext(MyContext)` — can be called conditionally
