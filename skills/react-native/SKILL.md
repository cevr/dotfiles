---
name: react-native
description: React Native performance patterns, native UI, animation, list optimization, and platform-specific practices. Use when writing React Native components, optimizing performance, implementing animations, or working with native navigation and gestures.
allowed-tools: Read, Grep, Glob, Edit, Write
---

# React Native Best Practices

## Navigation

```
What are you working on?
├─ Rendering crashes / broken UI          → §1 Core Rendering
├─ Slow lists / scroll jank               → §2 Lists
├─ Animations / gestures                  → §3 Animation
├─ Navigation setup                       → §4 Navigation
├─ State management                       → §5 State
├─ Native UI components                   → §6 UI
├─ Design system / component library      → §7 Design System
├─ React Compiler compatibility           → §8 Compiler
└─ Project setup / dependencies           → §9 Setup
```

---

## 1. Core Rendering (CRITICAL)

### Never Use && with Potentially Falsy Values

Unlike web React, rendering `0` or `""` outside `<Text>` **hard-crashes** React Native in production.

```tsx
// CRASHES if count=0
{count && <Text>{count} items</Text>}

// SAFE
{count > 0 ? <Text>{count} items</Text> : null}
{!!count && <Text>{count} items</Text>}
```

Lint rule: `react/jsx-no-leaked-render`.

### Wrap Strings in Text Components

Raw strings outside `<Text>` crash the app.

```tsx
// CRASHES
<View>Hello, {name}!</View>

// CORRECT
<View><Text>Hello, {name}!</Text></View>
```

---

## 2. List Performance (HIGH)

### Use a List Virtualizer

Always use LegendList or FlashList, even for short lists. `ScrollView` renders all children upfront — no recycling.

```tsx
<LegendList
  data={items}
  renderItem={({ item }) => <ItemCard item={item} />}
  keyExtractor={item => item.id}
  estimatedItemSize={80}
/>
```

### Stable Object References

Don't `.map()` or `.filter()` data before passing to virtualized lists. Virtualization relies on reference stability. Transform inside items.

```tsx
// BAD: New objects every keystroke
const domains = tlds.map(tld => ({ domain: `${keyword}.${tld.name}` }))
<LegendList data={domains} />

// GOOD: Stable data, transform in item
<LegendList data={tlds} renderItem={({ item }) => <DomainItem tld={item} />} />

function DomainItem({ tld }) {
  const domain = useKeywordStore(s => s.keyword + '.' + tld.name);
  return <Text>{domain}</Text>;
}
```

### Pass Primitives for Memoization

Primitives enable shallow comparison in `memo()`. Pass only fields the component uses.

```tsx
// BAD: New object each render
<UserRow user={{ id: item.id, name: item.name }} />

// GOOD: Primitives
<UserRow id={item.id} name={item.name} email={item.email} />
```

### Keep List Items Lightweight

No queries, no expensive computations, minimal hooks. Pass pre-computed values as props. Prefer Zustand selectors over React Context in list items (Context re-renders all consumers on any change).

```tsx
// BAD: Query + context in list item
function ProductRow({ id }) {
  const { data } = useQuery(['product', id], fetchProduct);
  const theme = useContext(ThemeContext);
  // ...
}

// GOOD: Primitives only
const ProductRow = memo(function ProductRow({ name, price, imageUrl }) {
  return <View><Image source={{ uri: imageUrl }} /><Text>{name}</Text></View>;
});
```

### Hoist Callbacks to List Root

One `useCallback` at the list level, passed to each item. Items call it with their ID.

### Use Item Types for Heterogeneous Lists

Discriminated union types + `getItemType` for separate recycling pools:

```tsx
type FeedItem = { type: 'header'; title: string } | { type: 'message'; text: string } | { type: 'image'; url: string };

<LegendList
  data={items}
  getItemType={item => item.type}
  renderItem={({ item }) => {
    switch (item.type) {
      case 'header': return <SectionHeader title={item.title} />;
      case 'message': return <MessageRow text={item.text} />;
      case 'image': return <ImageRow url={item.url} />;
    }
  }}
  recycleItems
/>
```

### Use Compressed Images

Request images at 2x display size: `${url}?w=200&h=200&fit=cover` for a 100x100 thumbnail.

---

## 3. Animation (HIGH)

### Animate Transform and Opacity Only

`width`, `height`, `top`, `left`, `margin`, `padding` trigger layout every frame. `transform` + `opacity` are GPU-accelerated.

```tsx
// BAD: Layout animation
useAnimatedStyle(() => ({ height: withTiming(expanded ? 200 : 0) }))

// GOOD: GPU-accelerated
useAnimatedStyle(() => ({
  transform: [{ scaleY: withTiming(expanded ? 1 : 0) }],
  opacity: withTiming(expanded ? 1 : 0),
}))
```

### State Represents Ground Truth, Derive Visuals

Store the semantic state, derive the visual output:

```tsx
// BAD: Storing visual output
const scale = useSharedValue(1);

// GOOD: Storing state, deriving visual
const pressed = useSharedValue(0);
const animatedStyle = useAnimatedStyle(() => ({
  transform: [{ scale: interpolate(pressed.get(), [0, 1], [1, 0.95]) }],
}));
```

### Prefer useDerivedValue Over useAnimatedReaction

```tsx
// BAD: Imperative reaction
useAnimatedReaction(() => progress.value, (current) => {
  opacity.value = 1 - current;
});

// GOOD: Declarative derivation
const opacity = useDerivedValue(() => 1 - progress.get());
```

Reserve `useAnimatedReaction` for side effects only (haptics, logging, `runOnJS`).

### Use GestureDetector for Animated Press States

`Gesture.Tap()` callbacks run on UI thread as worklets. No JS thread round-trip.

```tsx
const pressed = useSharedValue(0);
const tap = Gesture.Tap()
  .onBegin(() => pressed.set(withTiming(1)))
  .onFinalize(() => pressed.set(withTiming(0)))
  .onEnd(() => runOnJS(onPress)());

const animatedStyle = useAnimatedStyle(() => ({
  transform: [{ scale: interpolate(pressed.get(), [0, 1], [1, 0.95]) }],
}));
```

### Never Track Scroll Position in useState

Use Reanimated shared values (UI thread, no re-render):

```tsx
const scrollY = useSharedValue(0);
const onScroll = useAnimatedScrollHandler({
  onScroll: (e) => { scrollY.value = e.contentOffset.y; }
});
```

---

## 4. Navigation (HIGH)

### Use Native Navigators

- **Stacks**: `@react-navigation/native-stack` (NOT `@react-navigation/stack`)
- **Tabs**: `react-native-bottom-tabs` (NOT `@react-navigation/bottom-tabs`)
- **Expo Router** uses native navigators by default
- Use native header options, not custom header components

---

## 5. State (MEDIUM)

### Derive Values, Don't Store Them

```tsx
// BAD: State + effect to compute
const [total, setTotal] = useState(0);
useEffect(() => setTotal(items.reduce((s, i) => s + i.price, 0)), [items]);

// GOOD: Derive
const total = items.reduce((sum, item) => sum + item.price, 0);
```

### Fallback State Pattern

`undefined` = user hasn't chosen yet. Nullish coalescing for reactive fallbacks:

```tsx
const [_theme, setTheme] = useState<string | undefined>(undefined);
const theme = _theme ?? data.theme;  // Reactive to server refetch until user overrides
```

### Dispatch Updaters

When next state depends on current state, use functional updates:

```tsx
const onLayout = (e) => {
  const { width, height } = e.nativeEvent.layout;
  setSize(prev => {
    if (prev?.width === width && prev?.height === height) return prev;
    return { width, height };
  });
};
```

---

## 6. Native UI (MEDIUM)

### Modern Styling

- `borderCurve: 'continuous'` with `borderRadius` for iOS squircles
- `gap` instead of margin between children
- `experimental_backgroundImage: 'linear-gradient(...)'` — no third-party gradient lib needed
- `boxShadow: '0 2px 8px rgba(0,0,0,0.1)'` — CSS string syntax
- Vary `fontWeight` and color for hierarchy, not font sizes

### Use expo-image

Blurhash placeholders, priority loading, `cachePolicy`, `recyclingKey` for lists. Drop-in replacement for RN `Image`.

### Use Native Menus

`zeego` for cross-platform native dropdown and context menus. Supports submenus, checkbox items, destructive actions.

### Use Native Modals

```tsx
<Modal presentationStyle="formSheet" />
// or React Navigation v7
presentation: 'formSheet'
```

Not JS bottom sheets for standard modals.

### Use Pressable

`Pressable` over `TouchableOpacity`/`TouchableHighlight`. Use `react-native-gesture-handler`'s `Pressable` inside scrollable lists.

### Use Galeria for Image Galleries

`@nandorojo/galeria` — native shared element transitions, pinch-to-zoom, pan-to-close.

### contentInsetAdjustmentBehavior

```tsx
<ScrollView contentInsetAdjustmentBehavior="automatic" />
```

Instead of wrapping in `SafeAreaView`. Handles notches and dynamic island natively.

### Measuring View Dimensions

`useLayoutEffect` + `getBoundingClientRect()` for sync initial measurement. `onLayout` for updates. Functional `setState` to compare non-primitive values (avoid infinite loops).

---

## 7. Design System (MEDIUM)

### Compound Components Over Polymorphic Children

```tsx
// BAD: typeof children === 'string' checks
<Button>Save</Button>

// GOOD: Explicit subcomponents
<Button>
  <ButtonIcon><SaveIcon /></ButtonIcon>
  <ButtonText>Save</ButtonText>
</Button>
```

### Import from Design System Folder

Re-export from `@/components/view`, not directly from `react-native`. Enables global changes without touching every file.

---

## 8. React Compiler (MEDIUM)

### Destructure Functions Early

Compiler keys cache on object identity. Destructured values are stable.

```tsx
// BAD: Compiler keys on unstable object
const router = useRouter();
const handlePress = () => router.push('/success');

// GOOD: Stable destructured function
const { push } = useRouter();
const handlePress = () => push('/success');
```

### Use .get()/.set() for Reanimated Shared Values

Compiler can't track `.value` property access:

```tsx
// BAD
count.value = count.value + 1;

// GOOD
count.set(count.get() + 1);
```

---

## 9. Setup & Dependencies

### Install Native Dependencies in App Directory

Autolinking only scans the app's `node_modules`. In monorepos, native dependencies must be installed in the app package, not the root.

### Single Dependency Versions

Exact versions, root-level overrides via `pnpm.overrides` or yarn resolutions. Use `syncpack` to enforce.

### Load Fonts Natively at Build Time

Use `expo-font` config plugin to embed fonts at build time. No `useFonts` loading state needed at runtime.

### Hoist Intl Formatter Creation

```tsx
// BAD: Created every render (Intl objects are expensive to instantiate)
const formatted = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(price);

// GOOD: Module-level singleton
const currencyFormatter = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const formatted = currencyFormatter.format(price);
```

---

## Reference

Distilled from:
- [Vercel React Native Skills](https://github.com/vercel-labs/agent-skills/tree/main/skills/react-native-skills)
- [React Native Reanimated](https://docs.swmansion.com/react-native-reanimated)
- [React Native Gesture Handler](https://docs.swmansion.com/react-native-gesture-handler)
- [Expo Documentation](https://docs.expo.dev)
- [LegendList](https://legendapp.com/open-source/legend-list)
- [Zeego](https://zeego.dev)
