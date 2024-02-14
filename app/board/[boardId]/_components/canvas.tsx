'use client';

import { useCallback, useMemo, useState } from 'react';
import { Info } from './info';
import { Participants } from './participants';
import { Toolbar } from './toolbar';
import {
	Camera,
	CanvasMode,
	CanvasState,
	Color,
	LayerType,
	Point,
} from '@/types/canvas';
import {
	useHistory,
	useCanUndo,
	useCanRedo,
	useMutation,
	useStorage,
	useOthersMapped,
	useSelf,
} from '@/liveblocks.config';
import {
	connectionIdToColor,
	findIntersectingLayersWithRectangle,
	penPointsToPathLayer,
	pointerEventToCanvasPoint,
	resizeBounds,
} from '@/lib/utils';
import { CursorsPresence } from './cursors-presence';
import { nanoid } from 'nanoid';
import { LiveObject } from '@liveblocks/client';
import { LayerPreview } from './layer-preview';

const MAX_LAYERS = 100;

interface CanvasProps {
	boardId: string;
}

const Canvas = ({ boardId }: CanvasProps) => {
	const layerIds = useStorage((root) => root.layerIds);

	const history = useHistory();
	const canRedo = useCanRedo();
	const canUndo = useCanUndo();

	const [canvasState, setCanvasState] = useState<CanvasState>({
		mode: CanvasMode.None,
	});
	const [camera, setCamera] = useState<Camera>({ x: 0, y: 0 });

	const [lastUsedColor, setLastUsedColor] = useState<Color>({
		r: 0,
		g: 0,
		b: 0,
	});

	const insertLayer = useMutation(
		(
			{ storage, setMyPresence },
			layerType:
				| LayerType.Ellipse
				| LayerType.Rectangle
				| LayerType.Text
				| LayerType.Note,
			position: Point
		) => {
			const liveLayers = storage.get('layers');
			if (liveLayers.size >= MAX_LAYERS) {
				return;
			}

			const liveLayerIds = storage.get('layerIds');
			const layerId = nanoid();
			const layer = new LiveObject({
				type: layerType,
				x: position.x,
				y: position.y,
				height: 100,
				width: 100,
				fill: lastUsedColor,
			});

			liveLayerIds.push(layerId);
			liveLayers.set(layerId, layer);

			setMyPresence({ selection: [layerId] }, { addToHistory: true });
			setCanvasState({ mode: CanvasMode.None });
		},
		[lastUsedColor]
	);

	const unselectLayers = useMutation(({ self, setMyPresence }) => {
		if (self.presence.selection.length > 0) {
			setMyPresence({ selection: [] }, { addToHistory: true });
		}
	}, []);

	const insertPath = useMutation(
		({ storage, self, setMyPresence }) => {
			const liveLayers = storage.get('layers');
			const { pencilDraft } = self.presence;

			if (
				pencilDraft == null ||
				pencilDraft.length < 2 ||
				liveLayers.size >= MAX_LAYERS
			) {
				setMyPresence({ pencilDraft: null });
				return;
			}

			const id = nanoid();
			liveLayers.set(
				id,
				new LiveObject(penPointsToPathLayer(pencilDraft, lastUsedColor))
			);

			const liveLayerIds = storage.get('layerIds');
			liveLayerIds.push(id);

			setMyPresence({ pencilDraft: null });
			setCanvasState({ mode: CanvasMode.Pencil });
		},
		[lastUsedColor]
	);

	const startMultiSelection = useCallback((current: Point, origin: Point) => {
		if (Math.abs(current.x - origin.x) + Math.abs(current.y - origin.y) > 5) {
			setCanvasState({
				mode: CanvasMode.SelectionNet,
				origin,
				current,
			});
		}
	}, []);

	const updateSelectionNet = useMutation(
		({ storage, setMyPresence }, current: Point, origin: Point) => {
			const layers = storage.get('layers').toImmutable();
			setCanvasState({
				mode: CanvasMode.SelectionNet,
				origin,
				current,
			});

			const ids = findIntersectingLayersWithRectangle(
				layerIds,
				layers,
				origin,
				current
			);

			setMyPresence({ selection: ids });
		},
		[layerIds]
	);

	const translateSelectedLayers = useMutation(
		({ storage, self }, point: Point) => {
			if (canvasState.mode !== CanvasMode.Translating) {
				return;
			}

			const offset = {
				x: point.x - canvasState.current.x,
				y: point.y - canvasState.current.y,
			};

			const liveLayers = storage.get('layers');

			for (const id of self.presence.selection) {
				const layer = liveLayers.get(id);

				if (layer) {
					layer.update({
						x: layer.get('x') + offset.x,
						y: layer.get('y') + offset.y,
					});
				}
			}

			setCanvasState({ mode: CanvasMode.Translating, current: point });
		},
		[canvasState]
	);

	const resizeSelectedLayer = useMutation(
		({ storage, self }, point: Point) => {
			if (canvasState.mode !== CanvasMode.Resizing) {
				return;
			}

			const bounds = resizeBounds(
				canvasState.initialBounds,
				canvasState.corner,
				point
			);

			const liveLayers = storage.get('layers');
			const layer = liveLayers.get(self.presence.selection[0]);

			if (layer) {
				layer.update(bounds);
			}
		},
		[canvasState]
	);

	const continueDrawing = useMutation(
		({ self, setMyPresence }, point: Point, e: React.PointerEvent) => {
			const { pencilDraft } = self.presence;

			if (
				canvasState.mode !== CanvasMode.Pencil ||
				e.buttons !== 1 ||
				pencilDraft == null
			) {
				return;
			}

			setMyPresence({
				cursor: point,
				pencilDraft:
					pencilDraft.length === 1 &&
					pencilDraft[0][0] === point.x &&
					pencilDraft[0][1] === point.y
						? pencilDraft
						: [...pencilDraft, [point.x, point.y, e.pressure]],
			});
		},
		[canvasState.mode]
	);

	const startDrawing = useMutation(
		({ setMyPresence }, point: Point, pressure: number) => {
			setMyPresence({
				pencilDraft: [[point.x, point.y, pressure]],
				penColor: lastUsedColor,
			});
		},
		[lastUsedColor]
	);

	const onWheel = useCallback((e: React.WheelEvent) => {
		setCamera((camera) => ({
			x: camera.x - e.deltaX,
			y: camera.y - e.deltaY,
		}));
	}, []);

	const onPointerMove = useMutation(
		({ setMyPresence }, e: React.PointerEvent) => {
			e.preventDefault();

			const current = pointerEventToCanvasPoint(e, camera);

			if (canvasState.mode === CanvasMode.Pressing) {
				startMultiSelection(current, canvasState.origin);
			} else if (canvasState.mode === CanvasMode.SelectionNet) {
				updateSelectionNet(current, canvasState.origin);
			} else if (canvasState.mode === CanvasMode.Translating) {
				translateSelectedLayers(current);
			} else if (canvasState.mode === CanvasMode.Resizing) {
				resizeSelectedLayer(current);
			} else if (canvasState.mode === CanvasMode.Pencil) {
				continueDrawing(current, e);
			}

			setMyPresence({ cursor: current });
		},
		[
			continueDrawing,
			camera,
			canvasState,
			resizeSelectedLayer,
			translateSelectedLayers,
			startMultiSelection,
			updateSelectionNet,
		]
	);

	const onPointerLeave = useMutation(({ setMyPresence }) => {
		setMyPresence({ cursor: null });
	}, []);

	const onPointerDown = useCallback(
		(e: React.PointerEvent) => {
			const point = pointerEventToCanvasPoint(e, camera);

			if (canvasState.mode === CanvasMode.Inserting) {
				return;
			}

			if (canvasState.mode === CanvasMode.Pencil) {
				startDrawing(point, e.pressure);
				return;
			}

			setCanvasState({ origin: point, mode: CanvasMode.Pressing });
		},
		[camera, canvasState.mode, setCanvasState, startDrawing]
	);

	const onPointerUp = useMutation(
		({}, e) => {
			const point = pointerEventToCanvasPoint(e, camera);

			if (
				canvasState.mode === CanvasMode.None ||
				canvasState.mode === CanvasMode.Pressing
			) {
				unselectLayers();
				setCanvasState({
					mode: CanvasMode.None,
				});
			} else if (canvasState.mode === CanvasMode.Pencil) {
				insertPath();
			} else if (canvasState.mode === CanvasMode.Inserting) {
				insertLayer(canvasState.layerType, point);
			} else {
				setCanvasState({
					mode: CanvasMode.None,
				});
			}

			history.resume();
		},
		[
			setCanvasState,
			camera,
			canvasState,
			history,
			insertLayer,
			unselectLayers,
			insertPath,
		]
	);

	const selections = useOthersMapped((other) => other.presence.selection);

	const onLayerPointerDown = useMutation(
		({ self, setMyPresence }, e: React.PointerEvent, layerId: string) => {
			if (
				canvasState.mode === CanvasMode.Pencil ||
				canvasState.mode === CanvasMode.Inserting
			) {
				return;
			}

			history.pause();
			e.stopPropagation();

			const point = pointerEventToCanvasPoint(e, camera);

			if (!self.presence.selection.includes(layerId)) {
				setMyPresence({ selection: [layerId] }, { addToHistory: true });
			}
			setCanvasState({ mode: CanvasMode.Translating, current: point });
		},
		[setCanvasState, camera, history, canvasState.mode]
	);

	const layerIdsToColorSelection = useMemo(() => {
		const layerIdsToColorSelection: Record<string, string> = {};

		for (const user of selections) {
			const [connectionId, selection] = user;

			for (const layerId of selection) {
				layerIdsToColorSelection[layerId] = connectionIdToColor(connectionId);
			}
		}

		return layerIdsToColorSelection;
	}, [selections]);

	return (
		<main className='h-full w-full relative bg-neutral-100 touch-none'>
			<Info boardId={boardId} />
			<Participants />
			<Toolbar
				canvasState={canvasState}
				setCanvasState={setCanvasState}
				canRedo={canRedo}
				canUndo={canUndo}
				undo={history.undo}
				redo={history.redo}
			/>
			<svg
				className='h-[100vh] w-[100vw]'
				onWheel={onWheel}
				onPointerMove={onPointerMove}
				onPointerLeave={onPointerLeave}
				onPointerDown={onPointerDown}
				onPointerUp={onPointerUp}
			>
				<g
					style={{
						transform: `translate(${camera.x}px, ${camera.y}px)`,
					}}
				>
					{layerIds.map((layerId) => (
						<LayerPreview
							key={layerId}
							id={layerId}
							onLayerPointerDown={onLayerPointerDown}
							selectionColor={layerIdsToColorSelection[layerId]}
						/>
					))}
					<CursorsPresence />
				</g>
			</svg>
		</main>
	);
};

export default Canvas;
