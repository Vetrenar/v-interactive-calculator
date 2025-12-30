import {
    App,
    Editor,
    MarkdownPostProcessorContext,
    Modal,
    Notice,
    Plugin,
    PluginSettingTab,
    Setting,
    setIcon,
    MarkdownRenderer,
} from 'obsidian';
import { translations } from './translations';
import { FormulaCalculatorModal } from './FormulaCalculatorModal';

// --- INTERFACES ---

/**
 * Represents a single named formula within a calculator.
 */
export interface FormulaItem {
    name: string;
    value: string;
}

export interface Variable {
    name: string;
    label: string;
    type: 'number' | 'text' | 'boolean';
    value?: any;
    propertyMap?: string;
}

/**
 * Represents a complete calculator definition.
 */
export interface SavedCalculator {
    id: string;
    name: string;
    variables: Variable[];
    formulas: FormulaItem[];
    autoCalculate?: boolean;
    renderFormula?: boolean;
}

interface FormulaCalculatorSettings {
    language: 'en' | 'ru';
    showFormulaInModal: boolean;
    savedCalculators: SavedCalculator[];
}

const DEFAULT_SETTINGS: FormulaCalculatorSettings = {
    language: 'en',
    showFormulaInModal: true,
    savedCalculators: [],
};

// --- UTILITY FUNCTIONS ---
export function generateId(length: number = 8): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < length; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

export function isValidIdentifier(str: string): boolean {
    return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(str);
}

export function evaluateFormula(formula: string, context: { [key: string]: any }): any {
    const mathScope: { [key: string]: any } = {};
    for (const key of Object.getOwnPropertyNames(Math)) {
        mathScope[key] = (Math as any)[key];
    }
    const scope = { ...mathScope, Number, parseFloat, parseInt, isNaN, isFinite, ...context };
    const scopeKeys = Object.keys(scope);
    const scopeValues = Object.values(scope);
    const func = new Function(...scopeKeys, `"use strict"; return (${formula});`);
    return func(...scopeValues);
}

// --- PLUGIN MAIN CLASS ---
export default class FormulaCalculatorPlugin extends Plugin {
    settings: FormulaCalculatorSettings;

    get t() {
        return translations[this.settings.language] || translations['en'];
    }

    async onload() {
        await this.loadSettings();

        this.addRibbonIcon('calculator', this.t.ribbon_tooltip, () => new FormulaCalculatorModal(this.app, this).open());

        this.addCommand({
            id: 'open-formula-calculator',
            name: this.t.command_open_calculator,
            callback: () => new FormulaCalculatorModal(this.app, this).open()
        });

        this.addCommand({
            id: 'insert-calculator',
            name: this.t.command_insert_calculator,
            editorCallback: (editor: Editor) => {
                if (this.settings.savedCalculators.length === 0) {
                    new Notice(this.t.errors.NO_CALCULATORS_TO_INSERT);
                    return;
                }
                new InsertCalculatorModal(this.app, this, editor).open();
            }
        });

        this.addSettingTab(new FormulaCalculatorSettingTab(this.app, this));

        this.registerMarkdownCodeBlockProcessor('formula-calculator', this.handleCalculatorCodeBlock.bind(this));
    }

    async handleCalculatorCodeBlock(source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) {
        try {
            const trimmedSource = source.trim();
            let data: SavedCalculator | null = null;
            const isReference = !trimmedSource.startsWith('{');

            if (isReference) {
                const calculatorId = trimmedSource;
                const foundCalculator = this.settings.savedCalculators.find(c => c.id === calculatorId);
                if (!foundCalculator) throw new Error(this.t.errors.CALCULATOR_NOT_FOUND(calculatorId));
                data = JSON.parse(JSON.stringify(foundCalculator));
            } else {
                try {
                    const parsed = JSON.parse(trimmedSource);
                    data = { id: `raw-${generateId(4)}`, ...parsed };
                } catch (e: any) {
                    throw new Error(this.t.errors.INVALID_JSON(e.message));
                }
            }
            
            if (!data) throw new Error(this.t.errors.INVALID_CALCULATOR_DATA);

            // Backward compatibility: Convert old single-formula format
            if ((data as any).formula && !data.formulas) {
                const oldData = data as any;
                data.formulas = [{
                    name: oldData.resultLabel || 'Result',
                    value: oldData.formula
                }];
            }
            
            if (!data.name || !Array.isArray(data.variables) || !Array.isArray(data.formulas) || data.formulas.length === 0) {
                throw new Error(this.t.errors.INVALID_CALCULATOR_DATA);
            }

            // Map frontmatter properties to variables
            const fileCache = this.app.metadataCache.getCache(ctx.sourcePath);
            const frontmatter = fileCache?.frontmatter;
            if (frontmatter) {
                data.variables.forEach(variable => {
                    const mappedPropertyName = variable.propertyMap?.trim();
                    if (mappedPropertyName && frontmatter.hasOwnProperty(mappedPropertyName)) {
                        const noteValue = frontmatter[mappedPropertyName];
                        if (noteValue !== null && noteValue !== undefined) {
                            variable.value = noteValue;
                        }
                    }
                });
            }

            el.addClass('formula-calculator-container');
            
            // Render static content (title, formulas)
            const staticContentContainer = el.createDiv();
            let markdownString = `#### ${data.name}\n`;

            if (data.renderFormula) {
                data.formulas.forEach(formula => {
                    let formulaString = formula.value;
                    data.variables.forEach(v => {
                        const regex = new RegExp(`\\b${v.name}\\b`, 'g');
                        formulaString = formulaString.replace(regex, v.label || v.name);
                    });
                    formulaString = formulaString.replace(/\*/g, '×').replace(/\//g, '÷').replace(/PI/g, 'π');
                    markdownString += `**${formula.name}**: \`${formulaString}\`\n\n`;
                });
                markdownString += `---\n`;
            }
            await MarkdownRenderer.render(this.app, markdownString, staticContentContainer, ctx.sourcePath, this);

            // Render Variable Inputs
            const inputs: Record<string, HTMLInputElement> = {};
            const variables = data.variables;
            const defaultValues: Record<string, any> = {};
            
            variables.forEach(variable => {
                defaultValues[variable.name] = variable.value;
                const settingEl = el.createDiv({ cls: 'setting-item' });
                const infoEl = settingEl.createDiv({ cls: 'setting-item-info' });
                infoEl.createDiv({ text: variable.label || variable.name, cls: 'setting-item-name' });
                const controlEl = settingEl.createDiv({ cls: 'setting-item-control' });
                let inputEl: HTMLInputElement;
                switch (variable.type) {
                    case 'number':
                        inputEl = controlEl.createEl('input', { type: 'number', value: String(variable.value ?? '0') });
                        inputEl.step = 'any';
                        break;
                    case 'text':
                        inputEl = controlEl.createEl('input', { type: 'text', value: String(variable.value ?? '') });
                        break;
                    case 'boolean':
                        inputEl = controlEl.createEl('input', { type: 'checkbox' });
                        inputEl.checked = !!variable.value;
                        break;
                }
                inputs[variable.name] = inputEl;
            });

            // Render Result Displays
            const resultsContainer = el.createDiv({ cls: 'formula-calculator-results-container' });
            const resultElements: Record<string, { span: HTMLSpanElement; copyBtn: HTMLButtonElement }> = {};
            let currentResults: Record<string, any> = {};

            data.formulas.forEach(formula => {
                const resultEl = resultsContainer.createDiv({ cls: 'formula-calculator-result' });
                resultEl.createEl('strong', { text: `${formula.name}: ` });
                const resultSpan = resultEl.createEl('span');

                // --- MODIFICATION ---
                // Button size is now controlled by adding the '.small-btn' class.
                // The actual styles for this class are in 'styles.css'.
                const copyResultBtn = resultEl.createEl('button', { cls: 'formula-calculator-copy-btn small-btn' });
                copyResultBtn.ariaLabel = this.t.copy_result_button_label;
                setIcon(copyResultBtn, 'copy');

                copyResultBtn.style.display = 'none'; // Hide until there's a result
                copyResultBtn.style.marginLeft = '4px';
                copyResultBtn.addEventListener('click', () => {
                    if (currentResults[formula.name] !== null) {
                        navigator.clipboard.writeText(String(currentResults[formula.name]));
                        new Notice(this.t.notices.RESULT_COPIED);
                    }
                });
                resultElements[formula.name] = { span: resultSpan, copyBtn: copyResultBtn };
            });

            // Calculation Logic
            const performCalculation = () => {
                const currentContext: { [key: string]: any } = {};
                let hasError = false;

                variables.forEach(v => {
                    if (hasError) return;
                    const input = inputs[v.name];
                    try {
                        switch (v.type) {
                            case 'number':
                                const numVal = parseFloat(input.value);
                                if (isNaN(numVal)) throw new Error(this.t.errors.INVALID_NUMBER_VALUE(v.label));
                                currentContext[v.name] = numVal;
                                break;
                            case 'boolean': currentContext[v.name] = input.checked; break;
                            case 'text': currentContext[v.name] = input.value; break;
                        }
                    } catch (e: any) {
                        Object.values(resultElements).forEach(({ span }) => {
                           span.setText(`${this.t.modal.result_error_prefix}${e.message}`);
                           span.addClass('result-error');
                        });
                        hasError = true;
                    }
                });

                if (hasError) return;
                
                data.formulas.forEach(formula => {
                    const { span, copyBtn } = resultElements[formula.name];
                    copyBtn.style.display = 'none';
                    try {
                        const result = evaluateFormula(formula.value, currentContext);
                        currentResults[formula.name] = result;
                        span.setText(String(result));
                        span.removeClass('result-error');
                        copyBtn.style.display = 'inline-block';
                    } catch (e: any) {
                        currentResults[formula.name] = null;
                        span.setText(this.t.errors.CALCULATION_ERROR(e.message));
                        span.addClass('result-error');
                    }
                });
            };

            if (data.autoCalculate) {
                Object.values(inputs).forEach(input => input.addEventListener('input', performCalculation));
                performCalculation();
            }

            // Action Buttons
            const buttonContainer = el.createDiv({ cls: 'formula-calculator-buttons' });
            
            const calculateBtn = buttonContainer.createEl('button', { text: this.t.calculate_button, cls: 'mod-cta' });
            calculateBtn.addEventListener('click', performCalculation);

            const returnToDefaultBtn = buttonContainer.createEl('button', { text: this.t.reset_button });
            returnToDefaultBtn.addEventListener('click', () => {
                variables.forEach(v => {
                    const input = inputs[v.name];
                    const defaultValue = defaultValues[v.name];
                    switch (v.type) {
                        case 'boolean': input.checked = !!defaultValue; break;
                        default: input.value = String(defaultValue ?? (v.type === 'number' ? '0' : '')); break;
                    }
                });
                if (data.autoCalculate) performCalculation();
                new Notice(this.t.notices.VALUES_RESET);
            });
            
            if (isReference) {
                const refreshBtn = buttonContainer.createEl('button');
                setIcon(refreshBtn, 'refresh-cw');
                refreshBtn.ariaLabel = this.t.refresh_button_label;
                refreshBtn.addEventListener('click', () => {
                    // Refresh logic to re-read from settings and frontmatter
                });
            }

            const copyMarkdownBtn = buttonContainer.createEl('button');
            setIcon(copyMarkdownBtn, 'copy-check');
            copyMarkdownBtn.ariaLabel = this.t.copy_markdown_button_label;
            copyMarkdownBtn.addEventListener('click', () => {
                if (Object.keys(currentResults).length === 0) {
                    new Notice(this.t.notices.NO_RESULT_TO_COPY);
                    return;
                }
                
                let markdownLines = [`**${data.name}**:`];
                for(const formulaName in currentResults) {
                    if (currentResults[formulaName] !== null) {
                        markdownLines.push(`- **${formulaName}**: ${currentResults[formulaName]}`);
                    }
                }

                navigator.clipboard.writeText(markdownLines.join('\n'));
                new Notice(this.t.notices.MARKDOWN_COPIED);
            });

        } catch (error: any) {
            console.error('Formula calculator block error:', error);
            el.empty();
            const errorContainer = el.createEl('div', { cls: 'formula-calculator-error' });
            const errorMarkdown = `**${this.t.code_block_error_prefix}**\n\n\`\`\`\n${error.message}\n\`\`\``;
            await MarkdownRenderer.render(this.app, errorMarkdown, errorContainer, ctx.sourcePath, this);
        }
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }
}

// --- MODAL AND SETTINGS CLASSES ---
// These classes remain unchanged from your original provided code,
// as the logic within them is not affected by the styling change.

class InsertCalculatorModal extends Modal {
    constructor(app: App, private plugin: FormulaCalculatorPlugin, private editor: Editor) { super(app); }
    onClose() { this.contentEl.empty(); }
    onOpen() {
        const { contentEl } = this;
        const t = this.plugin.t;
        contentEl.empty();
        contentEl.createEl('h2', { text: t.insert_modal.title });
        contentEl.createEl('p', { cls: 'formula-calculator-modal-desc', innerHTML: t.insert_modal.description });
        let selectedCalculatorId = this.plugin.settings.savedCalculators[0]?.id || '';

        new Setting(contentEl).setName(t.insert_modal.select_label).addDropdown(dropdown => {
            this.plugin.settings.savedCalculators.forEach(calc => dropdown.addOption(calc.id, calc.name));
            dropdown.setValue(selectedCalculatorId).onChange(value => { selectedCalculatorId = value; });
        });
        
        new Setting(contentEl)
            .addButton(btn => btn.setButtonText(t.insert_modal.insert_ref_button).setCta().onClick(() => {
                const calculator = this.plugin.settings.savedCalculators.find(c => c.id === selectedCalculatorId);
                if (!calculator) { new Notice(t.errors.NO_CALCULATOR_SELECTED); return; }
                this.editor.replaceSelection("```formula-calculator\n" + calculator.id + "\n```");
                this.close();
            }))
            .addButton(btn => btn.setButtonText(t.insert_modal.insert_raw_button).onClick(() => {
                const calculator = this.plugin.settings.savedCalculators.find(c => c.id === selectedCalculatorId);
                if (!calculator) { new Notice(t.errors.NO_CALCULATOR_SELECTED); return; }
                
                const { name, variables, formulas, autoCalculate, renderFormula } = calculator;
                const jsonString = JSON.stringify({ name, variables, formulas, autoCalculate, renderFormula }, null, 2);
                
                this.editor.replaceSelection('```formula-calculator\n' + jsonString + '\n```');
                this.close();
                new Notice(t.errors.INSERTED_RAW_CODE(calculator.name));
            }));
    }
}

export class SaveCalculatorModal extends Modal {
    private calculatorName: string = '';
    private calculatorData: Omit<SavedCalculator, 'id' | 'name'>;

    constructor(app: App, private plugin: FormulaCalculatorPlugin, calculatorData: Omit<SavedCalculator, 'id' | 'name'>, private onSaveCallback: () => void) {
        super(app);
        this.calculatorData = calculatorData;
    }
    
    onOpen() {
        const { contentEl } = this;
        const t = this.plugin.t;
        contentEl.empty();
        contentEl.createEl('h2', { text: t.save_modal.title });

        new Setting(contentEl).setName(t.save_modal.name_label).addText(text => {
            text.setPlaceholder(t.save_modal.name_placeholder).setValue(this.calculatorName).onChange(value => { this.calculatorName = value.trim(); });
        });

        new Setting(contentEl)
            .addButton(btn => btn.setButtonText(t.buttons.cancel).onClick(() => this.close()))
            .addButton(btn => btn.setButtonText(t.buttons.save).setCta().onClick(async () => {
                if (!this.calculatorName) { new Notice(t.errors.CALCULATOR_NAME_REQUIRED); return; }
                if (this.plugin.settings.savedCalculators.some(c => c.name === this.calculatorName)) { new Notice(t.errors.CALCULATOR_NAME_EXISTS(this.calculatorName)); return; }

                const newCalculator: SavedCalculator = { id: generateId(), name: this.calculatorName, ...this.calculatorData };
                this.plugin.settings.savedCalculators.push(newCalculator);
                await this.plugin.saveSettings();
                new Notice(t.errors.CALCULATOR_SAVED(this.calculatorName));
                this.onSaveCallback();
                this.close();
            }));
    }

    onClose() { this.contentEl.empty(); }
}

class EditRawCalculatorModal extends Modal {
    private originalCalculator: SavedCalculator;
    private rawJson: string;

    constructor(app: App, private plugin: FormulaCalculatorPlugin, private calculatorId: string, private onSaveCallback: () => void) {
        super(app);
        const calc = this.plugin.settings.savedCalculators.find(c => c.id === this.calculatorId);
        if (!calc) throw new Error("Calculator not found for editing");
        this.originalCalculator = calc;
        
        const editableCalc = JSON.parse(JSON.stringify(this.originalCalculator));
        if ((editableCalc as any).formula && !editableCalc.formulas) {
             editableCalc.formulas = [{ name: (editableCalc as any).resultLabel || 'Result', value: (editableCalc as any).formula }];
             delete (editableCalc as any).formula;
             delete (editableCalc as any).resultLabel;
        }
        this.rawJson = JSON.stringify(editableCalc, null, 2);
    }
    
    onOpen() {
        const { contentEl } = this;
        const t = this.plugin.t;
        contentEl.empty();
        contentEl.createEl('h2', { text: t.edit_raw_modal.title(this.originalCalculator.name) });

        new Setting(contentEl).setDesc(t.edit_raw_modal.description).addTextArea(text => {
            text.setValue(this.rawJson).onChange(value => { this.rawJson = value; });
            text.inputEl.rows = 15;
            text.inputEl.style.width = '100%';
            text.inputEl.style.fontFamily = 'monospace';
        });

        new Setting(contentEl)
            .addButton(btn => btn.setButtonText(t.buttons.cancel).onClick(() => this.close()))
            .addButton(btn => btn.setButtonText(t.buttons.save).setCta().onClick(async () => {
                try {
                    const updatedCalculator: SavedCalculator = JSON.parse(this.rawJson);
                    if (!updatedCalculator.id || updatedCalculator.id !== this.originalCalculator.id) { new Notice(t.errors.ID_CANNOT_BE_CHANGED); return; }
                    if (!updatedCalculator.name || !Array.isArray(updatedCalculator.formulas) || !Array.isArray(updatedCalculator.variables)) { new Notice(t.errors.STRUCTURE_INVALID); return; }
                    
                    const index = this.plugin.settings.savedCalculators.findIndex(c => c.id === this.originalCalculator.id);
                    if (index !== -1) {
                        this.plugin.settings.savedCalculators[index] = updatedCalculator;
                        await this.plugin.saveSettings();
                    }
                    new Notice(t.errors.CALCULATOR_UPDATED(updatedCalculator.name));
                    this.onSaveCallback();
                    this.close();
                } catch (e: any) {
                    new Notice(t.errors.INVALID_JSON(e.message));
                }
            }));
    }
    onClose() { this.contentEl.empty(); }
}

class RenameCalculatorModal extends Modal {
    private newName: string;
    constructor(app: App, private plugin: FormulaCalculatorPlugin, private calculator: SavedCalculator, private onSaveCallback: () => void) {
        super(app);
        this.newName = this.calculator.name;
    }
    onOpen() {
        const { contentEl } = this;
        const t = this.plugin.t;
        contentEl.empty();
        contentEl.createEl('h2', { text: `Rename '${this.calculator.name}'` });

        new Setting(contentEl).setName("New calculator name").addText(text => {
            text.setValue(this.newName).setPlaceholder("Enter new name").onChange(value => { this.newName = value.trim(); });
            text.inputEl.focus();
            text.inputEl.select();
        });

        new Setting(contentEl).addButton(btn => btn.setButtonText(t.buttons.cancel).onClick(() => this.close())).addButton(btn => btn.setButtonText(t.buttons.save).setCta().onClick(async () => {
            if (!this.newName) { new Notice(t.errors.CALCULATOR_NAME_REQUIRED); return; }
            if (this.newName !== this.calculator.name && this.plugin.settings.savedCalculators.some(c => c.name === this.newName)) {
                new Notice(t.errors.CALCULATOR_NAME_EXISTS(this.newName));
                return;
            }
            const calcToUpdate = this.plugin.settings.savedCalculators.find(c => c.id === this.calculator.id);
            if (calcToUpdate) {
                const oldName = calcToUpdate.name;
                calcToUpdate.name = this.newName;
                await this.plugin.saveSettings();
                new Notice(`Renamed '${oldName}' to '${this.newName}'.`);
                this.onSaveCallback();
                this.close();
            }
        }));
    }
    onClose() { this.contentEl.empty(); }
}

class FormulaCalculatorSettingTab extends PluginSettingTab {
    constructor(app: App, private plugin: FormulaCalculatorPlugin) { super(app, plugin); }
    display(): void {
        const { containerEl } = this;
        const t = this.plugin.t;
        containerEl.empty();
        containerEl.createEl('h2', { text: t.settings.title });
        
        new Setting(containerEl).setName(t.settings.language_setting).setDesc(t.settings.language_desc).addDropdown(dropdown => {
            dropdown.addOption('en', 'English').addOption('ru', 'Русский').setValue(this.plugin.settings.language).onChange(async (value: 'en' | 'ru') => {
                this.plugin.settings.language = value;
                await this.plugin.saveSettings();
                new Notice(this.plugin.t.settings.language_notice);
                this.display(); // Re-render the tab with the new language
            });
        });

        containerEl.createEl('h3', { text: t.settings.saved_calculators_title });
        
         new Setting(containerEl).setDesc("Create a new calculator from scratch or import one from a file.").addButton(button => button.setButtonText(t.settings.add_new_button).setCta().onClick(() => {
            const modal = new FormulaCalculatorModal(this.app, this.plugin);
            modal.onClose = () => this.display(); // Refresh settings tab on close
            modal.open();
        })).addButton(button => button.setButtonText("Import").onClick(() => {
            // Import logic here
        }));

        if (this.plugin.settings.savedCalculators.length === 0) {
            containerEl.createEl('p', { text: t.settings.no_calculators_message });
            return;
        }

        this.plugin.settings.savedCalculators.forEach(calculator => {
            new Setting(containerEl).setName(calculator.name).setDesc(t.settings.id_label(calculator.id)).addExtraButton(btn => {
                btn.setIcon('pencil').setTooltip("Rename").onClick(() => {
                    new RenameCalculatorModal(this.app, this.plugin, calculator, () => this.display()).open();
                });
            }).addExtraButton(btn => {
                btn.setIcon('copy').setTooltip("Duplicate").onClick(async () => {
                    const newCalculator = JSON.parse(JSON.stringify(calculator));
                    newCalculator.id = generateId();
                    let newName = `${calculator.name} (copy)`;
                    let counter = 2;
                    while (this.plugin.settings.savedCalculators.some(c => c.name === newName)) {
                        newName = `${calculator.name} (copy ${counter++})`;
                    }
                    newCalculator.name = newName;
                    this.plugin.settings.savedCalculators.push(newCalculator);
                    await this.plugin.saveSettings();
                    this.display();
                    new Notice(`Duplicated '${calculator.name}' to '${newName}'.`);
                });
            }).addExtraButton(btn => {
                btn.setIcon('upload').setTooltip("Export").onClick(() => {
                    // Export logic here
                });
            }).addExtraButton(btn => {
                btn.setIcon('settings').setTooltip(t.buttons.edit).onClick(() => {
                    const modal = new FormulaCalculatorModal(this.app, this.plugin, calculator);
                    modal.onClose = () => this.display();
                    modal.open();
                });
            }).addExtraButton(btn => {
                btn.setIcon('code').setTooltip(t.buttons.edit_raw).onClick(() => {
                    new EditRawCalculatorModal(this.app, this.plugin, calculator.id, () => this.display()).open();
                });
            }).addExtraButton(btn => {
                btn.setIcon('trash').setTooltip(t.buttons.delete).onClick(() => {
                    new ConfirmationModal(this.app, t.confirm_modal.delete_title(calculator.name), t.confirm_modal.delete_message, async () => {
                        this.plugin.settings.savedCalculators = this.plugin.settings.savedCalculators.filter(c => c.id !== calculator.id);
                        await this.plugin.saveSettings();
                        this.display();
                        new Notice(t.errors.CALCULATOR_DELETED(calculator.name));
                    }, this.plugin).open();
                });
            });
        });
    }
}

class ConfirmationModal extends Modal {
    constructor(app: App, private title: string, private message: string, private onConfirm: () => void, private plugin: FormulaCalculatorPlugin) { super(app); }
    onClose() { this.contentEl.empty(); }
    onOpen() {
        const { contentEl } = this;
        const t = this.plugin.t;
        contentEl.empty();
        contentEl.createEl('h2', { text: this.title });
        contentEl.createEl('p', { text: this.message });
        new Setting(contentEl).addButton(btn => btn.setButtonText(t.buttons.cancel).onClick(() => this.close())).addButton(btn => btn.setButtonText(t.buttons.confirm).setWarning().onClick(() => {
            this.onConfirm();
            this.close();
        }));
    }
}