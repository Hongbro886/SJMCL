import { Box, Center, Icon, Text, VStack } from "@chakra-ui/react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { IconType } from "react-icons";
import { LuFileUp } from "react-icons/lu";

export type FileDnDRegistry = {
  extensions: string[];
  titleKey?: string;
  descKey?: string;
  icon?: IconType;
  onDrop: (path: string) => void | Promise<void>;
};

type Entry = { id: symbol; registries: FileDnDRegistry[] };
type StackItem = { registry: FileDnDRegistry; rank: number };

const FileDnDContext = createContext<null | {
  upsert: (id: symbol, registries: FileDnDRegistry | FileDnDRegistry[]) => void;
  remove: (id: symbol) => void;
}>(null);

const getFileInfo = (path: string) => {
  const fileName = path.split(/[\\/]/).pop() || path;
  const dotIndex = fileName.lastIndexOf(".");
  return {
    fileName,
    extension: dotIndex < 0 ? "" : fileName.slice(dotIndex + 1).toLowerCase(),
  };
};

const rebuildStacks = (entries: Entry[]) => {
  const stacks = new Map<string, StackItem[]>();
  let rank = 0;

  for (const entry of entries) {
    for (const registry of entry.registries) {
      for (const extension of registry.extensions) {
        const key = extension.trim().toLowerCase();
        if (!key) continue;
        const stack = stacks.get(key);
        const item = { registry, rank: rank++ };
        if (stack) stack.push(item);
        else stacks.set(key, [item]);
      }
    }
  }

  return stacks;
};

const findMatch = (paths: string[], stacks: Map<string, StackItem[]>) => {
  // Prefer the latest registered handler among all matched extensions.
  let best: {
    registry: FileDnDRegistry;
    path: string;
    fileName: string;
    rank: number;
  } | null = null;

  for (const path of paths) {
    const { fileName, extension } = getFileInfo(path);
    const item = stacks.get(extension)?.at(-1);
    if (!item || (best && item.rank <= best.rank)) continue;
    best = { registry: item.registry, path, fileName, rank: item.rank };
  }

  return best;
};

export const useFileDnD = (registries: FileDnDRegistry | FileDnDRegistry[]) => {
  const context = useContext(FileDnDContext);
  const idRef = useRef(Symbol("file-dnd"));

  useEffect(() => {
    if (!context) return;
    // Keep the latest registration synced with the provider.
    context.upsert(idRef.current, registries);
  }, [context, registries]);

  useEffect(() => {
    if (!context) return;
    const id = idRef.current;
    return () => context.remove(id);
  }, [context]);
};

export const FileDnDProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const { t } = useTranslation();
  const [dragPaths, setDragPaths] = useState<string[] | null>(null);
  const entriesRef = useRef<Entry[]>([]);
  const stacksRef = useRef<Map<string, StackItem[]>>(new Map());

  // The provider maintains a list of registered handlers and their derived stacks for efficient lookup.
  const upsert = useCallback(
    (id: symbol, registries: FileDnDRegistry | FileDnDRegistry[]) => {
      const next = Array.isArray(registries) ? registries : [registries];
      const current = entriesRef.current.find((item) => item.id === id);
      if (current) current.registries = next;
      else entriesRef.current.push({ id, registries: next });
      // Rebuild the extension lookup after every registry change.
      stacksRef.current = rebuildStacks(entriesRef.current);
    },
    []
  );

  const remove = useCallback((id: symbol) => {
    entriesRef.current = entriesRef.current.filter((item) => item.id !== id);
    stacksRef.current = rebuildStacks(entriesRef.current);
  }, []);

  const activeMatch = dragPaths
    ? findMatch(dragPaths, stacksRef.current)
    : null;

  // Listen to drag-drop events from the webview.
  useEffect(() => {
    let cleanup: (() => void) | undefined;

    (async () => {
      const unlisten = await getCurrentWebview().onDragDropEvent((event) => {
        if (event.payload.type === "leave") {
          setDragPaths(null);
          return;
        }
        if (event.payload.type !== "enter" && event.payload.type !== "drop") {
          return;
        }
        if (event.payload.type === "enter") {
          // Store incoming paths so the overlay can reflect the active handler.
          setDragPaths(event.payload.paths);
          return;
        }

        const match = findMatch(event.payload.paths, stacksRef.current);
        setDragPaths(null);
        if (!match) return;

        Promise.resolve(match.registry.onDrop(match.path)).catch((error) => {
          logger.error("Failed to handle dropped files:", error);
        });
      });

      cleanup = unlisten;
    })().catch((error) => {
      logger.error("Failed to listen to drag-drop events:", error);
    });

    return () => cleanup?.();
  }, []);

  const fileName = activeMatch?.fileName || "";
  const title = activeMatch?.registry.titleKey
    ? t(activeMatch.registry.titleKey, { fileName })
    : t("General.import");
  const desc = activeMatch?.registry.descKey
    ? t(activeMatch.registry.descKey, { fileName })
    : "";
  const overlayIcon = activeMatch?.registry.icon || LuFileUp;

  return (
    <FileDnDContext.Provider value={{ upsert, remove }}>
      {children}
      {activeMatch && (
        <>
          <Box
            position="absolute"
            inset={0}
            zIndex={1400}
            pointerEvents="none"
            bg="blackAlpha.600"
            backdropFilter="blur(10px)"
          />
          <Box
            position="absolute"
            inset={4}
            zIndex={1401}
            pointerEvents="none"
            borderRadius="md"
            borderWidth="2px"
            borderStyle="dashed"
            borderColor="whiteAlpha.600"
          >
            <Center w="100%" h="100%">
              <VStack spacing={2} maxW="min(480px, calc(100% - 32px))">
                <Icon as={overlayIcon} boxSize={10} color="white" />
                <Text color="white" fontSize="lg" fontWeight="600">
                  {title}
                </Text>
                {desc && (
                  <Text color="white" fontSize="sm" textAlign="center">
                    {desc}
                  </Text>
                )}
              </VStack>
            </Center>
          </Box>
        </>
      )}
    </FileDnDContext.Provider>
  );
};
