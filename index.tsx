import React, { useState, useCallback, FC } from 'react';
import { createRoot } from 'react-dom/client';
import { GoogleGenAI, Type } from "@google/genai";
import pica from 'pica';

// --- Helper Functions ---
const formatBytes = (bytes: number, decimals = 2): string => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
};

const fileToDataURL = (file: File): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
};

const dataURLtoBlob = (dataURL: string): Blob => {
    const parts = dataURL.split(',');
    const mimeType = parts[0].match(/:(.*?);/)?.[1];
    const bstr = atob(parts[1]);
    let n = bstr.length;
    const u8arr = new Uint8Array(n);
    while (n--) {
        u8arr[n] = bstr.charCodeAt(n);
    }
    return new Blob([u8arr], { type: mimeType });
};

const getImageDimensions = (file: File): Promise<{ width: number, height: number }> => {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
            resolve({ width: img.width, height: img.height });
            URL.revokeObjectURL(img.src);
        };
        img.onerror = reject;
        img.src = URL.createObjectURL(file);
    });
};


// --- API & Compression Logic ---
let ai;
try {
  ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
} catch (error) {
  console.error("Failed to initialize GoogleGenAI:", error);
}

const getAIRecommendedSize = async (file: File) => {
    if (!ai) throw new Error("AI Client not initialized.");
    
    let prompt;
    let schema;

    if (file.type.startsWith('image/')) {
        prompt = `For a file named "${file.name}" of type ${file.type} and size ${formatBytes(file.size)}, suggest a recommended compressed size in bytes. The goal is a good balance between quality and size reduction. Also, provide a very brief reason for your suggestion (e.g., 'Good for web use', 'Maintains print quality'). Respond ONLY with JSON.`;
        schema = {
            type: Type.OBJECT,
            properties: {
                recommendedSize: { type: Type.NUMBER, description: "Suggested target file size in bytes." },
                reason: { type: Type.STRING, description: "A brief reason for the suggestion." }
            },
            required: ["recommendedSize", "reason"]
        };
    } else if (file.type === 'application/pdf') {
        prompt = `For a PDF file named "${file.name}" of size ${formatBytes(file.size)}, suggest a recommended compressed size in bytes and a compression mode ('lossless' for preserving all details, 'lossy' for maximum size reduction). The goal is a good balance between quality and size reduction. Also, provide a very brief reason for your suggestion. Respond ONLY with JSON.`;
        schema = {
            type: Type.OBJECT,
            properties: {
                recommendedSize: { type: Type.NUMBER, description: "Suggested target file size in bytes." },
                reason: { type: Type.STRING, description: "A brief reason for the suggestion." },
                recommendedMode: { type: Type.STRING, enum: ['lossless', 'lossy'], description: "Recommended compression mode." }
            },
            required: ["recommendedSize", "reason", "recommendedMode"]
        };
    } else {
        throw new Error("Unsupported file type for recommendation");
    }

    const response = await ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: prompt,
        config: {
            responseMimeType: "application/json",
            responseSchema: schema
        },
    });

    const result = JSON.parse(response.text);
    return {
        recommendedSize: result.recommendedSize,
        reason: result.reason,
        recommendedPdfMode: result.recommendedMode
    };
};


const getAICompressionSuggestion = async (file: File, enableSmartResize: boolean, targetSize?: number, targetUnit?: 'KB' | 'MB') => {
    if (!ai) throw new Error("AI Client not initialized.");
    
    let prompt = `Act as a file compression expert. For a file named "${file.name}" of type ${file.type} and size ${formatBytes(file.size)}, provide the best compression settings to significantly reduce size while preserving quality. For images, suggest a target quality (0-100) and if converting to WebP is a good idea.`;

    if (targetSize && targetUnit) {
        prompt += ` The user has specified a target size of approximately ${targetSize} ${targetUnit}. Prioritize getting close to this size while maintaining the best possible quality.`;
    }

    if (enableSmartResize) {
        const { width, height } = await getImageDimensions(file);
        prompt += ` The original dimensions are ${width}x${height}px. Also suggest an optimal new resolution (targetWidth and targetHeight) that preserves key details and aspect ratio for maximum file size reduction.`
    }
    
    prompt += ` Respond ONLY with JSON.`

    const schema: any = {
        type: Type.OBJECT,
        properties: {
            targetQuality: { type: Type.NUMBER, description: "A value between 0 and 100 for JPEG/WebP quality." },
            convertToWebp: { type: Type.BOOLEAN, description: "Whether to convert PNG/JPEG to WebP for better compression." },
            recommendation: { type: Type.STRING, description: "A brief explanation for the chosen settings." }
        },
        required: ["targetQuality", "convertToWebp", "recommendation"]
    };

    if (enableSmartResize) {
        schema.properties.targetWidth = { type: Type.NUMBER, description: "Suggested new width for the image." };
        schema.properties.targetHeight = { type: Type.NUMBER, description: "Suggested new height for the image." };
    }

    const response = await ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: prompt,
        config: {
            responseMimeType: "application/json",
            responseSchema: schema
        },
    });
    
    return JSON.parse(response.text);
};

const getAIReport = async (originalSize: number, newSize: number) => {
    if (!ai) throw new Error("AI Client not initialized.");
    const reduction = (((originalSize - newSize) / originalSize) * 100).toFixed(0);
    const prompt = `Generate a brief, encouraging compression report. Original size: ${formatBytes(originalSize)}, new size: ${formatBytes(newSize)}. Percentage saved: ${reduction}%. Keep it under 20 words.`;
    
    const response = await ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: prompt
    });

    return response.text;
}

const getAIPdfReport = async (originalSize: number, newSize: number, mode?: 'lossless' | 'lossy') => {
    if (!ai) throw new Error("AI Client not initialized.");
    const reduction = (((originalSize - newSize) / originalSize) * 100).toFixed(0);
    let prompt = `Generate a brief, encouraging compression report for a PDF file. Original size: ${formatBytes(originalSize)}, new size: ${formatBytes(newSize)}. Percentage saved: ${reduction}%.`;
    
    if (mode === 'lossless') {
        prompt += ` Mention that document fidelity and quality are perfectly preserved.`;
    } else {
        prompt += ` Mention that readability is preserved, making it great for sharing.`;
    }
    
    prompt += ` Keep it under 25 words.`;
    
    const response = await ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: prompt
    });

    return response.text;
}

const compressImage = async (file: File, settings: { targetQuality: number; convertToWebp: boolean; targetWidth?: number; targetHeight?: number }): Promise<Blob> => {
    const picaInstance = pica();
    const offScreenCanvas = document.createElement('canvas');
    const dataUrl = await fileToDataURL(file);
    const image = new Image();
    
    await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = reject;
        image.src = dataUrl;
    });

    offScreenCanvas.width = settings.targetWidth || image.width;
    offScreenCanvas.height = settings.targetHeight || image.height;

    await picaInstance.resize(image, offScreenCanvas);

    const mimeType = settings.convertToWebp ? 'image/webp' : 'image/jpeg';
    const quality = settings.targetQuality / 100;

    const compressedDataUrl = await picaInstance.toBlob(offScreenCanvas, mimeType, quality).then(blob => {
        return new Promise<string>(resolve => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as string);
            reader.readAsDataURL(blob);
        });
    });

    return dataURLtoBlob(compressedDataUrl);
};


// --- Types ---
type FileStatus = 'analyzing' | 'pending' | 'compressing' | 'done' | 'error';
type PdfCompressionMode = 'lossless' | 'lossy';

interface AppFile {
    id: string;
    file: File;
    status: FileStatus;
    // Image specific
    smartResize: boolean;
    targetSizeInput?: string;
    targetUnit?: 'KB' | 'MB';
    // PDF specific
    pdfCompressionMode?: PdfCompressionMode;
    recommendedPdfMode?: PdfCompressionMode;
    // General
    recommendedSize?: number;
    recommendationReason?: string;
    compressedFile?: File;
    compressedSize?: number;
    aiReport?: string;
    errorMessage?: string;
}

// --- React Components ---

const FileCard: FC<{ 
    appFile: AppFile;
    index: number;
    onCompress: (id: string) => void; 
    onToggleSmartResize: (id: string, checked: boolean) => void;
    onTargetSizeChange: (id: string, value: string, unit: 'KB' | 'MB') => void;
    onPdfModeChange: (id: string, mode: PdfCompressionMode) => void;
    onRemove: (id: string) => void;
}> = ({ appFile, index, onCompress, onToggleSmartResize, onTargetSizeChange, onPdfModeChange, onRemove }) => {
    const { file, status, compressedFile, compressedSize, aiReport, errorMessage, smartResize, recommendedSize, recommendationReason, targetSizeInput, targetUnit, pdfCompressionMode, recommendedPdfMode } = appFile;
    const originalSize = file.size;
    const newSize = compressedSize;

    const renderStatus = () => {
        switch (status) {
            case 'analyzing':
                return <div className="analyzing-status"><span>✨</span><span>Analyzing...</span></div>;
            case 'pending':
                return (
                    <div className="pending-actions">
                         {recommendedSize && recommendationReason && (
                            <div className="ai-suggestion">
                                <p>💡 AI Suggests: <strong>~{formatBytes(recommendedSize)}</strong></p>
                                <span>{recommendationReason}</span>
                            </div>
                         )}
                         {file.type.startsWith('image/') && (
                            <>
                                <div className="target-size-input-container">
                                    <label htmlFor={`target-size-${appFile.id}`}>Target</label>
                                    <input
                                        type="number"
                                        min="0"
                                        id={`target-size-${appFile.id}`}
                                        className="target-size-input"
                                        value={targetSizeInput}
                                        placeholder="Auto"
                                        onChange={(e) => onTargetSizeChange(appFile.id, e.target.value, targetUnit || 'KB')}
                                    />
                                    <select
                                        className="target-unit-select"
                                        value={targetUnit || 'KB'}
                                        onChange={(e) => onTargetSizeChange(appFile.id, targetSizeInput || '', e.target.value as 'KB' | 'MB')}
                                    >
                                        <option value="KB">KB</option>
                                        <option value="MB">MB</option>
                                    </select>
                                </div>
                                <div className="smart-resize-option" onClick={() => onToggleSmartResize(appFile.id, !smartResize)}>
                                    <input
                                        type="checkbox"
                                        id={`smart-resize-${appFile.id}`}
                                        checked={!!smartResize}
                                        onChange={(e) => onToggleSmartResize(appFile.id, e.target.checked)}
                                    />
                                    <label htmlFor={`smart-resize-${appFile.id}`}>✨ AI Smart Resize</label>
                                </div>
                            </>
                        )}
                        {file.type === 'application/pdf' && (
                           <div className="pdf-options-container">
                                <p className="options-label">Compression Mode</p>
                                <div className="radio-group">
                                    <div className="radio-option">
                                        <input type="radio" id={`lossless-${appFile.id}`} name={`mode-${appFile.id}`} value="lossless" checked={pdfCompressionMode === 'lossless'} onChange={(e) => onPdfModeChange(appFile.id, e.target.value as PdfCompressionMode)} />
                                        <label htmlFor={`lossless-${appFile.id}`}>Lossless</label>
                                    </div>
                                    <div className="radio-option">
                                        <input type="radio" id={`lossy-${appFile.id}`} name={`mode-${appFile.id}`} value="lossy" checked={pdfCompressionMode === 'lossy'} onChange={(e) => onPdfModeChange(appFile.id, e.target.value as PdfCompressionMode)} />
                                        <label htmlFor={`lossy-${appFile.id}`}>Lossy</label>
                                    </div>
                                </div>
                                {recommendedPdfMode && <small className="ai-mode-suggestion">💡 AI suggests: <strong>{recommendedPdfMode}</strong></small>}
                           </div>
                        )}
                        <button className="button button-primary" onClick={() => onCompress(appFile.id)}>Compress</button>
                    </div>
                );
            case 'compressing':
                return <button className="button button-primary" disabled><div className="loader"></div>AI is thinking...</button>;
            case 'done':
                 if (typeof newSize === 'number') {
                    const reduction = (((originalSize - newSize) / originalSize) * 100).toFixed(0);
                    return (
                        <div className="compression-status success">
                            <div className="size-report">
                                <span className="original">{formatBytes(originalSize)}</span> → <span className="new">{formatBytes(newSize)}</span> <span className="reduction">-{reduction}%</span>
                            </div>
                            {aiReport && <p className="ai-report">{aiReport}</p>}
                            <a href={URL.createObjectURL(compressedFile!)} download={compressedFile!.name} className="button button-secondary" style={{marginTop: '1rem', textDecoration: 'none'}}>Download</a>
                        </div>
                    );
                }
                return null;
            case 'error':
                return (
                    <div className="compression-status error">
                        <p>{errorMessage || 'An unknown error occurred.'}</p>
                        <button className="button button-tertiary" onClick={() => onRemove(appFile.id)}>Clear</button>
                    </div>
                );
        }
    };

    return (
        <div className="file-card" style={{ '--i': index } as React.CSSProperties}>
            <div className="file-info">
                <div className="file-icon-wrapper">
                    {file.type.startsWith('image/') ? (
                        <img src={URL.createObjectURL(file)} alt={file.name} className="file-icon" />
                    ) : (
                        <svg className="file-icon pdf-icon" viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
                            <path d="M20 2H8C6.9 2 6 2.9 6 4V16C6 17.1 6.9 18 8 18H20C21.1 18 22 17.1 22 16V4C22 2.9 21.1 2 20 2ZM20 16H8V4H20V16ZM4 6H2V20C2 21.1 2.9 22 4 22H18V20H4V6Z"/>
                        </svg>
                    )}
                </div>
                <div className="file-details">
                    <p className="file-name" title={file.name}>{file.name}</p>
                    <p className="file-size">{formatBytes(originalSize)}</p>
                </div>
            </div>
            <div className="file-actions">
                {renderStatus()}
            </div>
        </div>
    );
};

const DropZone: FC<{ onFilesAdded: (files: File[]) => void }> = ({ onFilesAdded }) => {
    const [isDragging, setIsDragging] = useState(false);

    const handleDrag = (e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.type === 'dragenter' || e.type === 'dragover') {
            setIsDragging(true);
        } else if (e.type === 'dragleave') {
            setIsDragging(false);
        }
    };

    const handleDrop = (e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        setIsDragging(false);
        if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
            onFilesAdded(Array.from(e.dataTransfer.files));
        }
    };
    
    const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.files && e.target.files.length > 0) {
            onFilesAdded(Array.from(e.target.files));
        }
    };

    return (
        <div className={`drop-zone ${isDragging ? 'dragging' : ''}`} onDragEnter={handleDrag} onDragOver={handleDrag} onDragLeave={handleDrag} onDrop={handleDrop} onClick={() => document.getElementById('file-input')?.click()}>
            <input type="file" id="file-input" multiple style={{ display: 'none' }} accept="image/jpeg,image/png,application/pdf" onChange={handleFileSelect} />
            <svg className="drop-zone-icon" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                <path strokeLinecap="round" strokeLinejoin="round" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M12 15l-3-3m0 0l3-3m-3 3h12" />
            </svg>
            <p className="drop-zone-text">Drag & drop files or click to select</p>
            <button className="button button-secondary">Select Files</button>
        </div>
    );
};

const App: FC = () => {
    const [files, setFiles] = useState<AppFile[]>([]);

    const handleAddFiles = useCallback((newFiles: File[]) => {
        const appFiles: AppFile[] = newFiles.map(file => {
            const isSupported = ['image/jpeg', 'image/png', 'image/jpg', 'application/pdf'].includes(file.type);
            if (!isSupported) {
                return {
                    id: `${file.name}-${file.lastModified}`,
                    file,
                    status: 'error',
                    smartResize: false,
                    errorMessage: `Unsupported file type. Please use JPG, PNG, or PDF.`
                };
            }
            return {
                id: `${file.name}-${file.lastModified}`,
                file,
                status: 'analyzing',
                smartResize: false,
                targetSizeInput: '',
                targetUnit: 'KB',
                pdfCompressionMode: 'lossy'
            };
        });
        
        setFiles(prev => [...prev, ...appFiles]);

        appFiles.forEach(async (appFile) => {
            if(appFile.status !== 'analyzing') return;

            try {
                const { recommendedSize, reason, recommendedPdfMode } = await getAIRecommendedSize(appFile.file);
                setFiles(prev => prev.map(f => f.id === appFile.id ? { ...f, status: 'pending', recommendedSize, recommendationReason: reason, recommendedPdfMode, pdfCompressionMode: recommendedPdfMode || 'lossy' } : f));
            } catch (error) {
                console.error("Failed to get recommendation:", error);
                const errorMessage = error instanceof Error ? `AI analysis failed: ${error.message}` : "Could not get AI suggestion.";
                setFiles(prev => prev.map(f => f.id === appFile.id ? { ...f, status: 'error', errorMessage } : f));
            }
        });
    }, []);
    
    const handleToggleSmartResize = useCallback((id: string, checked: boolean) => {
        setFiles(prev => prev.map(f => f.id === id ? { ...f, smartResize: checked } : f));
    }, []);

    const handleTargetSizeChange = useCallback((id: string, value: string, unit: 'KB' | 'MB') => {
        setFiles(prev => prev.map(f => f.id === id ? { ...f, targetSizeInput: value, targetUnit: unit } : f));
    }, []);
    
    const handlePdfModeChange = useCallback((id: string, mode: PdfCompressionMode) => {
        setFiles(prev => prev.map(f => f.id === id ? { ...f, pdfCompressionMode: mode } : f));
    }, []);

    const handleRemoveFile = useCallback((id: string) => {
        setFiles(prev => prev.filter(f => f.id !== id));
    }, []);

    const handleCompress = useCallback(async (id:string) => {
        setFiles(prev => prev.map(f => f.id === id ? { ...f, status: 'compressing' } : f));

        const appFile = files.find(f => f.id === id);
        if (!appFile) return;

        try {
            if (appFile.file.type.startsWith('image/')) {
                 const targetSize = parseFloat(appFile.targetSizeInput || '');
                 const settings = await getAICompressionSuggestion(
                     appFile.file, 
                     appFile.smartResize,
                     !isNaN(targetSize) && targetSize > 0 ? targetSize : undefined,
                     appFile.targetUnit
                 );
                 const compressedBlob = await compressImage(appFile.file, settings);
                 
                 const originalName = appFile.file.name.substring(0, appFile.file.name.lastIndexOf('.'));
                 const newExtension = settings.convertToWebp ? 'webp' : 'jpeg';
                 const newName = `${originalName}.${newExtension}`;
                 
                 const compressedFile = new File([compressedBlob], newName, { type: compressedBlob.type });

                 const report = await getAIReport(appFile.file.size, compressedFile.size);
                 
                 setFiles(prev => prev.map(f => f.id === id ? { ...f, status: 'done', compressedFile, compressedSize: compressedFile.size, aiReport: report } : f));
            } else if (appFile.file.type === 'application/pdf') {
                 // Simulate PDF compression as it's complex for client-side
                 await new Promise(resolve => setTimeout(resolve, 2500)); // Simulate processing time

                 const originalSize = appFile.file.size;
                 
                 let reductionFactor;
                 if(appFile.pdfCompressionMode === 'lossless') {
                     // Simulate a believable reduction for lossless (e.g., 10% to 30%)
                     reductionFactor = 0.1 + Math.random() * 0.2;
                 } else { // 'lossy'
                    // Simulate a believable reduction for lossy (e.g., 40% to 80%)
                    reductionFactor = 0.4 + Math.random() * 0.4;
                 }
                 
                 const compressedSize = Math.round(originalSize * (1 - reductionFactor));
                 
                 const report = await getAIPdfReport(originalSize, compressedSize, appFile.pdfCompressionMode);
                 
                 const originalName = appFile.file.name.substring(0, appFile.file.name.lastIndexOf('.'));
                 const newName = `${originalName}-compressed.pdf`;

                 // For the demo, the downloadable file is a copy of the original.
                 const compressedFile = new File([appFile.file], newName, { type: 'application/pdf' });

                 setFiles(prev => prev.map(f => f.id === id ? { ...f, status: 'done', compressedFile, compressedSize, aiReport: report } : f));
            } else {
                 throw new Error(`Unsupported file type: ${appFile.file.type}`);
            }

        } catch (error) {
            console.error("Compression failed:", error);
            const errorMessage = error instanceof Error ? error.message : "An unknown error occurred.";
            setFiles(prev => prev.map(f => f.id === id ? { ...f, status: 'error', errorMessage } : f));
        }
    }, [files]);
    
    const handleClearAll = () => setFiles([]);
    
    const handleDownloadAll = () => {
        files.forEach(appFile => {
            if(appFile.status === 'done' && appFile.compressedFile) {
                const link = document.createElement('a');
                link.href = URL.createObjectURL(appFile.compressedFile);
                link.download = appFile.compressedFile.name;
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);
            }
        });
    };
    
    const canDownloadAll = files.some(f => f.status === 'done');

    return (
        <>
            {files.length === 0 ? (
                <DropZone onFilesAdded={handleAddFiles} />
            ) : (
                <>
                    <div className="file-list">
                        {files.map((appFile, index) => (
                            <FileCard 
                                key={appFile.id} 
                                appFile={appFile} 
                                index={index}
                                onCompress={handleCompress} 
                                onToggleSmartResize={handleToggleSmartResize}
                                onTargetSizeChange={handleTargetSizeChange}
                                onPdfModeChange={handlePdfModeChange}
                                onRemove={handleRemoveFile}
                            />
                        ))}
                    </div>
                    <div className="global-actions">
                        <button className="button button-secondary" onClick={handleClearAll}>Clear All</button>
                        {canDownloadAll && <button className="button button-primary" onClick={handleDownloadAll}>Download All</button>}
                    </div>
                </>
            )}
        </>
    );
};

const container = document.getElementById('root');
if(container) {
    const root = createRoot(container);
    root.render(<App />);
}