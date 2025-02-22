/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { parse as vueSfcParse } from 'vue/compiler-sfc';
import type { Plugin } from 'vite';
import fs from 'node:fs';
import { glob } from 'glob';
import JSON5 from 'json5';
import { randomUUID } from 'crypto';
import MagicString from 'magic-string';
import path from 'node:path'
import { hash, toBase62 } from '../vite.config';

export interface AnalysisResult {
	filePath: string;
	usage: ComponentUsageInfo[];
}

export interface ComponentUsageInfo {
	staticProps: Record<string, string>;
	bindProps: Record<string, string>;
}

function outputAnalysisResultAsTS(outputPath: string, analysisResults: AnalysisResult[]): void {
	// (outputAnalysisResultAsTS 関数の実装は前回と同様)
	const varName = 'searchIndexes'; //  変数名

	const jsonString = JSON5.stringify(analysisResults, { space: "\t", quote: "'" }); //  JSON.stringify で JSON 文字列を生成

	//  bindProps の値を文字列置換で修正する関数
	function modifyBindPropsInString(jsonString: string): string {
		const modifiedString = jsonString.replace(
			/bindProps:\s*\{([^}]*)\}/g, //  bindProps: { ... } にマッチ (g フラグで複数箇所を置換)
			(match, bindPropsBlock) => {
				//  bindPropsBlock ( { ... } 内) の各プロパティをさらに置換
				const modifiedBlock = bindPropsBlock.replace(
					/(.*):\s*\'(.*)\'/g, //  propName: 'propValue' にマッチ
					(propMatch, propName, propValue) => {
						return `${propName}: ${propValue}`; // propValue のクォートを除去
					}
				).replaceAll("\\'", "'");
				return `bindProps: {${modifiedBlock}}`; //  置換後の block で bindProps: { ... } を再構成
			}
		);
		return modifiedString;
	}


	const tsOutput = `
/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// This file was automatically generated by create-search-index.
// Do not edit this file.

import { i18n } from '@/i18n.js';

export const ${varName} = ${modifyBindPropsInString(jsonString)} as const;

export type AnalysisResults = typeof ${varName};
export type ComponentUsageInfo = AnalysisResults[number]['usage'][number];
`;

	try {
		fs.writeFileSync(outputPath, tsOutput, 'utf-8');
	} catch (error) {
		console.error('[create-search-index]: error: ', error);
	}
}

function extractUsageInfoFromTemplateAst(
	templateAst: any,
	code: string,
): ComponentUsageInfo[] {
	const usageInfoList: ComponentUsageInfo[] = [];

	if (!templateAst) {
		return usageInfoList;
	}

	function traverse(node: any) {
		if (node.type === 1 && node.tag === 'SearchMarker') {
			// 元々の props を staticProps に全て展開する
			const staticProps: Record<string, string> = {};
			if (node.props && Array.isArray(node.props)) {
				node.props.forEach((prop: any) => {
					if (prop.type === 6 && prop.name) {
						staticProps[prop.name] = prop.value?.content || '';
					}
				});
			}
			// markerId は __markerId または既存の props から取得
			const markerId = node.__markerId || staticProps['markerId'];
			if (markerId) {
				staticProps['markerId'] = markerId;
			}

			const bindProps: Record<string, any> = {};

			// 元々の props から bindProps を抽出
			if (node.props && Array.isArray(node.props)) {
				node.props.forEach((prop: any) => {
					if (prop.type === 7 && prop.name === 'bind' && prop.arg.content) {
						bindProps[prop.arg.content] = prop.exp?.content || '';
					}
				});
			}

			// __children がある場合、bindProps に children を追加
			if (node.__children) {
				bindProps['children'] = node.__children;
			} else if (node.props && Array.isArray(node.props)) {
				const childrenProp = node.props.find(
					(prop: any) =>
						prop.type === 7 &&
						prop.name === 'bind' &&
						prop.arg?.content === 'children'
				);
				if (childrenProp && childrenProp.exp) {
					try {
						bindProps['children'] = JSON5.parse(
							code.slice(childrenProp.exp.loc.start.offset, childrenProp.exp.loc.end.offset).replace(/'/g, '"')
						);
					} catch (e) {
						console.error('Error parsing :children attribute', e);
					}
				}
			}

			usageInfoList.push({
				staticProps,
				bindProps,
			});
		}

		if (node.children && Array.isArray(node.children)) {
			node.children.forEach((child: any) => traverse(child));
		}
	}

	traverse(templateAst);
	return usageInfoList;
}

export async function analyzeVueProps(options: {
	targetFilePaths: string[],
	exportFilePath: string,
	transformedCodeCache: Record<string, string>
}): Promise<void> {
	const analysisResults: AnalysisResult[] = [];

	//  対象ファイルパスを glob で展開
	const filePaths = options.targetFilePaths.reduce<string[]>((acc, filePathPattern) => {
		const matchedFiles = glob.sync(filePathPattern);
		return [...acc, ...matchedFiles];
	}, []);


	for (const filePath of filePaths) {
		const code = options.transformedCodeCache[path.resolve(filePath)]; // options 経由でキャッシュ参照
		if (!code) { // キャッシュミスの場合
			console.error(`[create-search-index] Error: No cached code found for: ${filePath}.`); // エラーログ
			continue;
		}
		const { descriptor, errors } = vueSfcParse(code, {
			filename: filePath,
		});

		if (errors.length) {
			console.error(`[create-search-index] Compile Error: ${filePath}`, errors);
			continue; // エラーが発生したファイルはスキップ
		}

		const usageInfo = extractUsageInfoFromTemplateAst(descriptor.template?.ast, code);
		if (!usageInfo) continue;

		if (usageInfo.length > 0) {
			analysisResults.push({
				filePath: filePath,
				usage: usageInfo,
			});
		}
	}

	outputAnalysisResultAsTS(options.exportFilePath, analysisResults); // outputAnalysisResultAsTS を呼び出す
}

interface MarkerRelation {
	parentId?: string;
	markerId: string;
	node: any;
}

async function processVueFile(
	code: string,
	id: string,
	options: { targetFilePaths: string[], exportFilePath: string },
	transformedCodeCache: Record<string, string>
) {
	const s = new MagicString(code); // magic-string のインスタンスを作成
	const parsed = vueSfcParse(code, { filename: id });
	if (!parsed.descriptor.template) {
		return;
	}
	const ast = parsed.descriptor.template.ast; // テンプレート AST を取得
	const markerRelations: MarkerRelation[] = []; //  MarkerRelation 配列を初期化

	if (ast) {
		function traverse(node: any, currentParent?: any) {
			if (node.type === 1 && node.tag === 'SearchMarker') {
				// 行番号はコード先頭からの改行数で取得
				const lineNumber = code.slice(0, node.loc.start.offset).split('\n').length;
				// ファイルパスと行番号からハッシュ値を生成
				const generatedMarkerId = toBase62(hash(`${id}:${lineNumber}`));

				const props = node.props || [];
				const hasMarkerIdProp = props.some((prop: any) => prop.type === 6 && prop.name === 'markerId');
				const nodeMarkerId = hasMarkerIdProp
					? props.find((prop: any) => prop.type === 6 && prop.name === 'markerId')?.value?.content as string
					: generatedMarkerId;
				node.__markerId = nodeMarkerId;

				// 子マーカーの場合、親ノードに __children を設定しておく
				if (currentParent && currentParent.type === 1 && currentParent.tag === 'SearchMarker') {
					currentParent.__children = currentParent.__children || [];
					currentParent.__children.push(nodeMarkerId);
				}

				const parentMarkerId = currentParent && currentParent.__markerId;
				markerRelations.push({
					parentId: parentMarkerId,
					markerId: nodeMarkerId,
					node: node,
				});

				if (!hasMarkerIdProp) {
					const startTagEnd = code.indexOf('>', node.loc.start.offset);
					if (startTagEnd !== -1) {
						s.appendRight(startTagEnd, ` markerId="${generatedMarkerId}"`);
					}
				}
			}

			const newParent = node.type === 1 && node.tag === 'SearchMarker' ? node : currentParent;
			if (node.children && Array.isArray(node.children)) {
				node.children.forEach(child => traverse(child, newParent));
			}
		}


		traverse(ast); // AST を traverse (1段階目: ID 生成と親子関係記録)

		// 2段階目: :children 属性の追加
		markerRelations.forEach(relation => {
			if (relation.parentId) { // 親 ID が存在する (子マーカーである) 場合
				const parentRelation = markerRelations.find(r => r.markerId === relation.parentId); // 親 Relation を検索
				if (parentRelation && parentRelation.node) {
					const parentNode = parentRelation.node;
					const childrenProp = parentNode.props?.find((prop: any) => prop.type === 7 && prop.name === 'bind' && prop.arg?.content === 'children');
					const childMarkerId = relation.markerId;

					if (childrenProp) {
						// 既存の :children 属性を JavaScript 配列として解析・更新
						try {
							const childrenStart = code.indexOf('[', childrenProp.exp.loc.start.offset);
							const childrenEnd = code.indexOf(']', childrenProp.exp.loc.start.offset);
							if (childrenStart !== -1 && childrenEnd !== -1) {
								const childrenArrayStr = code.slice(childrenStart, childrenEnd + 1);
								const childrenArray = JSON5.parse(childrenArrayStr.replace(/'/g, '"')); // JSON5 で解析 (シングルクォート対応)
								childrenArray.push(childMarkerId); // 子マーカーIDを追加
								const updatedChildrenArrayStr = JSON.stringify(childrenArray).replace(/"/g, "'"); // シングルクォートの配列文字列に再変換
								s.overwrite(childrenStart, childrenEnd + 1, updatedChildrenArrayStr); // 属性値を書き換え
							}
						} catch (e) {
							console.error('[create-search-index] Error updating :children attribute:', e); // エラーログ
						}
					} else {
						// :children 属性が存在しない場合は新規作成 (テンプレートリテラルを使用)
						const startTagEnd = code.indexOf('>', parentNode.loc.start.offset); // 親の開始タグの閉じ > の位置
						if (startTagEnd !== -1) {
							s.appendRight(startTagEnd, ` :children="${JSON.stringify([childMarkerId]).replace(/"/g, "'")}"`); // :children 属性を追記
						}
					}
				}
			}
		});


	}

	const transformedCode = s.toString(); //  変換後のコードを取得
	transformedCodeCache[id] = transformedCode; //  変換後のコードをキャッシュに保存

	return {
		code: transformedCode, // 変更後のコードを返す
		map: s.generateMap({ source: id, includeContent: true }), // ソースマップも生成 (sourceMap: true が必要)
	};
}


// Rollup プラグインとして export
export default function pluginCreateSearchIndex(options: {
	targetFilePaths: string[],
	exportFilePath: string
}): Plugin {
	let transformedCodeCache: Record<string, string> = {}; //  キャッシュオブジェクトをプラグインスコープで定義
	const isDevServer = process.env.NODE_ENV === 'development'; // 開発サーバーかどうか

	return {
		name: 'createSearchIndex',
		enforce: 'pre',

		async buildStart() {
			if (!isDevServer) {
				return;
			}

			const filePaths = options.targetFilePaths.reduce<string[]>((acc, filePathPattern) => {
				const matchedFiles = glob.sync(filePathPattern);
				return [...acc, ...matchedFiles];
			}, []);

			for (const filePath of filePaths) {
				const id = path.resolve(filePath); // 絶対パスに変換
				const code = fs.readFileSync(filePath, 'utf-8'); // ファイル内容を読み込む
				await processVueFile(code, id, options, transformedCodeCache); // processVueFile 関数を呼び出す
			}


			await analyzeVueProps({ ...options, transformedCodeCache }); // 開発サーバー起動時にも analyzeVueProps を実行
		},

		async transform(code, id) {
			if (!id.endsWith('.vue')) {
				return;
			}

			// targetFilePaths にマッチするファイルのみ処理を行う
			// glob パターンでマッチング
			let isMatch = false; // isMatch の初期値を false に設定
			for (const pattern of options.targetFilePaths) { // パターンごとにマッチング確認
				const globbedFiles = glob.sync(pattern);
				for (const globbedFile of globbedFiles) {
					const normalizedGlobbedFile = path.resolve(globbedFile); // glob 結果を絶対パスに
					const normalizedId = path.resolve(id); // id を絶対パスに
					if (normalizedGlobbedFile === normalizedId) { // 絶対パス同士で比較
						isMatch = true;
						break; // マッチしたらループを抜ける
					}
				}
				if (isMatch) break; // いずれかのパターンでマッチしたら、outer loop も抜ける
			}


			if (!isMatch) {
				return;
			}

			const transformed = await processVueFile(code, id, options, transformedCodeCache);
			if (isDevServer) {
				await analyzeVueProps({ ...options, transformedCodeCache }); // analyzeVueProps を呼び出す
			}
			return transformed;
		},

		async writeBundle() {
			await analyzeVueProps({ ...options, transformedCodeCache }); // ビルド時にも analyzeVueProps を実行
		},
	};
}
